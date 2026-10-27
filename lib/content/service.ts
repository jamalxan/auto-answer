/**
 * ETAP 13 — the post service: everything a route or the MCP layer does to
 * a ScheduledPost short of talking to Meta (that is lib/content/publish.ts).
 *
 * Rules enforced here, not in routes: workspace scoping (foreign id → 404),
 * the status machine (transitions.ts), optimistic locking by `version`,
 * the field matrix (validate.ts) before anything is scheduled, the five
 * minute lead time, the two-minute spacing of one account's posts, the
 * 24-hour quota, and the campaign binding. Every mutation that moves a
 * status is a compare-and-swap on status (updates by the user also carry
 * the version they saw) so two tabs or a worker and a user cannot both win.
 */

import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { done, type ServiceResult } from "@/lib/crm/result";
import { carouselMaxItems, CONTENT_LIMITS, maxCollaborators, PREPARE_LEAD_MS } from "./config";
import { ContentError, notFound } from "./errors";
import { activateLinkedCampaigns, attachCampaignToPost, linkedCampaignSummary, pauseLinkedCampaigns, type LinkedCampaignSummary } from "./link-campaign";
import { reprepareCleanedMedia, signedMediaUrl } from "./media";
import { accountQuota, quotaWindowFull } from "./quota";
import { removePostJobs, scheduleManualNotify, schedulePrepare, schedulePublish } from "./queue";
import type { MediaItemInput, PostInput, PostsQuery, PostStatusValue, PostTypeValue, PostUpdateInput } from "./schema";
import { normalizeUsernames } from "./text";
import { canTransition, EDITABLE, QUEUED } from "./transitions";
import { campaignKeywordWarnings, isVideoType, scheduleIssues, validatePost, type MediaFacts, type ValidationIssue } from "./validate";

export { activateLinkedCampaigns };

// ─── Result plumbing ────────────────────────────────────────────────────────

export async function run<T>(fn: () => Promise<T>): Promise<ServiceResult<T>> {
  try {
    return done(await fn());
  } catch (error) {
    if (error instanceof ContentError) return { ok: false, status: error.status, error: error.message };
    const message = error instanceof Error ? error.message : "Kutilmagan xato";
    console.error("[Content] service error:", message);
    return { ok: false, status: 500, error: "Kutilmagan xato — birozdan keyin qayta urinib ko'ring" };
  }
}

// ─── Shapes handed to the UI ────────────────────────────────────────────────

export interface PostMediaView {
  id: string;
  mediaId: string;
  position: number;
  altText: string | null;
  userTags: Array<{ username: string; x?: number; y?: number }>;
  cropRect: { x: number; y: number; w: number; h: number } | null;
  kind: string;
  status: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbUrl: string | null;
  previewUrl: string | null;
}

export interface PublishAttemptView {
  id: string;
  step: string;
  ok: boolean;
  metaCode: number | null;
  message: string | null;
  durationMs: number | null;
  createdAt: Date;
}

export interface PostDetail {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  accountUsername: string | null;
  type: PostTypeValue;
  status: PostStatusValue;
  caption: string | null;
  firstComment: string | null;
  collaborators: string[];
  shareToFeed: boolean;
  coverMediaId: string | null;
  thumbOffsetMs: number | null;
  trialStrategy: string | null;
  audioName: string | null;
  locationId: string | null;
  isAiGenerated: boolean;
  autoPublish: boolean;
  manualReason: string | null;
  scheduledAt: Date | null;
  timezone: string;
  igMediaId: string | null;
  permalink: string | null;
  publishedAt: Date | null;
  firstCommentStatus: string | null;
  attempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  labels: string[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
  media: PostMediaView[];
  attemptsLog: PublishAttemptView[];
  linkedCampaign: LinkedCampaignSummary | null;
  issues: ValidationIssue[];
  /** Non-blocking hints (FR-L5 caption keyword); scheduling ignores them. */
  warnings: ValidationIssue[];
  /** FR-C9 / FR-S8: the story series or recurrence this post belongs to. */
  series: SeriesInfo | null;
}

export interface SeriesInfo {
  id: string;
  /** 1-based place of this post among the live items ("Seriya: 2/3"). */
  position: number;
  total: number;
  items: Array<{ id: string; seriesIndex: number; status: PostStatusValue; scheduledAt: Date | null }>;
}

export interface PostCard {
  id: string;
  instagramAccountId: string;
  accountUsername: string | null;
  type: PostTypeValue;
  status: PostStatusValue;
  caption: string | null;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  permalink: string | null;
  thumbUrl: string | null;
  mediaCount: number;
  linked: boolean;
  autoPublish: boolean;
  lastErrorCode: string | null;
  version: number;
  seriesId: string | null;
  seriesIndex: number | null;
}

const POST_INCLUDE = {
  instagramAccount: { select: { username: true } },
  media: { include: { media: true }, orderBy: { position: "asc" as const } },
  attemptsLog: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.ScheduledPostInclude;

export type PostRow = Prisma.ScheduledPostGetPayload<{ include: typeof POST_INCLUDE }>;

function validateOpts(now?: Date, storySeries = true) {
  return { carouselMax: carouselMaxItems(), maxCollaborators: maxCollaborators(), now, storySeries };
}

function factsOf(asset: { id: string; kind: string; status: string; width: number | null; height: number | null; durationMs: number | null; sizeBytes: bigint | number; preparedBytes?: number | null }): MediaFacts {
  return {
    id: asset.id,
    kind: asset.kind as MediaFacts["kind"],
    status: asset.status as MediaFacts["status"],
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    // Instagram's size limits apply to the prepared copy Meta will fetch, not to the upload.
    sizeBytes: Number(asset.preparedBytes ?? asset.sizeBytes),
  };
}

function inputOfRow(row: PostRow): PostInput {
  return {
    instagramAccountId: row.instagramAccountId,
    type: row.type,
    caption: row.caption ?? undefined,
    firstComment: row.firstComment ?? undefined,
    collaborators: row.collaborators,
    shareToFeed: row.shareToFeed,
    coverMediaId: row.coverMediaId,
    thumbOffsetMs: row.thumbOffsetMs,
    trialStrategy: row.trialStrategy as PostInput["trialStrategy"],
    audioName: row.audioName,
    locationId: row.locationId,
    isAiGenerated: row.isAiGenerated,
    autoPublish: row.autoPublish,
    manualReason: row.manualReason as PostInput["manualReason"],
    media: row.media.map((m) => ({
      mediaId: m.mediaId,
      altText: m.altText ?? undefined,
      userTags: (m.userTags as MediaItemInput["userTags"]) ?? [],
      cropRect: (m.cropRect as MediaItemInput["cropRect"]) ?? undefined,
    })),
    labels: row.labels,
  };
}

/** The field-matrix check of a stored row (used by schedule, resume, the UI's issue list). */
export function issuesOfRow(row: PostRow, now?: Date): ValidationIssue[] {
  const facts = row.media.map((m) => factsOf(m.media));
  const issues = validatePost(inputOfRow(row), facts, validateOpts(now));
  if (row.coverMediaId) {
    // The cover is not part of `media`; its facts come from the row when loaded.
  }
  return issues;
}

async function toDetail(row: PostRow): Promise<PostDetail> {
  const linkedCampaign = await linkedCampaignSummary(row.id);
  const media = await Promise.all(
    row.media.map(async (m) => ({
      id: m.id,
      mediaId: m.mediaId,
      position: m.position,
      altText: m.altText ?? null,
      userTags: ((m.userTags as PostMediaView["userTags"]) ?? []) as PostMediaView["userTags"],
      cropRect: (m.cropRect as PostMediaView["cropRect"]) ?? null,
      kind: m.media.kind,
      status: m.media.status,
      width: m.media.width ?? null,
      height: m.media.height ?? null,
      durationMs: m.media.durationMs ?? null,
      thumbUrl: m.media.thumbKey ? await signedMediaUrl(m.media.thumbKey) : null,
      previewUrl: m.media.preparedKey ? await signedMediaUrl(m.media.preparedKey) : null,
    }))
  );
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    instagramAccountId: row.instagramAccountId,
    accountUsername: row.instagramAccount?.username ?? null,
    type: row.type,
    status: row.status,
    caption: row.caption,
    firstComment: row.firstComment,
    collaborators: row.collaborators,
    shareToFeed: row.shareToFeed,
    coverMediaId: row.coverMediaId,
    thumbOffsetMs: row.thumbOffsetMs,
    trialStrategy: row.trialStrategy,
    audioName: row.audioName,
    locationId: row.locationId,
    isAiGenerated: row.isAiGenerated,
    autoPublish: row.autoPublish,
    manualReason: row.manualReason,
    scheduledAt: row.scheduledAt,
    timezone: row.timezone,
    igMediaId: row.igMediaId,
    permalink: row.permalink,
    publishedAt: row.publishedAt,
    firstCommentStatus: row.firstCommentStatus,
    attempts: row.attempts,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    labels: row.labels,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    media,
    attemptsLog: row.attemptsLog.map((a) => ({ id: a.id, step: a.step, ok: a.ok, metaCode: a.metaCode, message: a.message, durationMs: a.durationMs, createdAt: a.createdAt })),
    linkedCampaign,
    issues: issuesOfRow(row),
    warnings: campaignKeywordWarnings(row.type, row.caption, linkedCampaign?.keywords ?? []),
    series: await seriesOf(row),
  };
}

async function seriesOf(row: PostRow): Promise<SeriesInfo | null> {
  if (!row.seriesId) return null;
  const items = await prisma.scheduledPost.findMany({
    where: { workspaceId: row.workspaceId, seriesId: row.seriesId, deletedAt: null },
    orderBy: [{ seriesIndex: "asc" }, { scheduledAt: "asc" }],
    select: { id: true, seriesIndex: true, status: true, scheduledAt: true },
  });
  const list = items.map((i) => ({ id: i.id, seriesIndex: i.seriesIndex ?? 0, status: i.status, scheduledAt: i.scheduledAt }));
  return { id: row.seriesId, position: list.findIndex((i) => i.id === row.id) + 1, total: list.length, items: list };
}

// ─── Loading ────────────────────────────────────────────────────────────────

export async function loadRow(workspaceId: string, postId: string): Promise<PostRow> {
  const row = await prisma.scheduledPost.findUnique({ where: { id: postId }, include: POST_INCLUDE });
  if (!row || row.workspaceId !== workspaceId || row.deletedAt) throw notFound();
  return row;
}

export async function getPost(workspaceId: string, postId: string): Promise<PostDetail> {
  return toDetail(await loadRow(workspaceId, postId));
}

async function ownedAccount(workspaceId: string, accountId: string) {
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId }, select: { id: true, workspaceId: true, username: true } });
  if (!account || account.workspaceId !== workspaceId) throw notFound("Instagram akkaunt topilmadi");
  return account;
}

/** Every referenced asset must be the workspace's and not deleted. */
async function ownedMedia(workspaceId: string, ids: string[]): Promise<Map<string, MediaFacts>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: unique } } });
  const map = new Map<string, MediaFacts>();
  for (const asset of assets) {
    if (asset.workspaceId !== workspaceId || asset.status === "DELETED") continue;
    map.set(asset.id, factsOf(asset));
  }
  for (const id of unique) if (!map.has(id)) throw notFound("Media topilmadi");
  return map;
}

// ─── Create / edit ──────────────────────────────────────────────────────────

function scalarData(input: Partial<PostInput>, type: PostTypeValue) {
  const story = type === "STORY";
  return {
    ...(input.caption !== undefined ? { caption: story ? null : input.caption || null } : {}),
    ...(input.firstComment !== undefined ? { firstComment: story ? null : input.firstComment || null } : {}),
    ...(input.collaborators !== undefined ? { collaborators: story ? [] : normalizeUsernames(input.collaborators) } : {}),
    ...(input.shareToFeed !== undefined ? { shareToFeed: input.shareToFeed } : {}),
    ...(input.coverMediaId !== undefined ? { coverMediaId: input.coverMediaId } : {}),
    ...(input.thumbOffsetMs !== undefined ? { thumbOffsetMs: input.thumbOffsetMs } : {}),
    ...(input.trialStrategy !== undefined ? { trialStrategy: input.trialStrategy } : {}),
    ...(input.audioName !== undefined ? { audioName: input.audioName } : {}),
    ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
    ...(input.isAiGenerated !== undefined ? { isAiGenerated: input.isAiGenerated } : {}),
    ...(input.autoPublish !== undefined ? { autoPublish: input.autoPublish } : {}),
    ...(input.manualReason !== undefined ? { manualReason: input.manualReason } : {}),
    ...(input.labels !== undefined ? { labels: input.labels } : {}),
  };
}

function mediaRows(postId: string, media: MediaItemInput[]) {
  return media.map((m, position) => ({
    postId,
    mediaId: m.mediaId,
    position,
    altText: m.altText ?? null,
    userTags: (m.userTags ?? []) as Prisma.InputJsonValue,
    cropRect: (m.cropRect ?? undefined) as Prisma.InputJsonValue | undefined,
  }));
}

/** A draft may be incomplete; only the "video can never be a feed image" rule is hard. */
function hardIssues(input: PostInput, facts: Map<string, MediaFacts>): ValidationIssue[] {
  return validatePost(input, [...facts.values()], validateOpts()).filter((i) => i.field === "type");
}

export async function createPost(workspaceId: string, userId: string | null, input: PostInput): Promise<PostDetail> {
  await ownedAccount(workspaceId, input.instagramAccountId);
  const facts = await ownedMedia(workspaceId, [...input.media.map((m) => m.mediaId), ...(input.coverMediaId ? [input.coverMediaId] : [])]);
  const hard = hardIssues(input, facts);
  if (hard.length) throw new ContentError(400, hard[0].message);
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });

  const created = await prisma.scheduledPost.create({
    data: {
      workspaceId,
      instagramAccountId: input.instagramAccountId,
      createdById: userId ?? undefined,
      type: input.type,
      status: "DRAFT",
      timezone: workspace?.timezone ?? "Asia/Tashkent",
      ...scalarData(input, input.type),
    },
  });
  if (input.media.length) await prisma.scheduledPostMedia.createMany({ data: mediaRows(created.id, input.media) });
  await reprepareCleanedMedia(workspaceId, input.media.map((m) => m.mediaId));
  if (input.linkCampaign !== undefined) await attachCampaignToPost(workspaceId, created.id, input.linkCampaign);
  return getPost(workspaceId, created.id);
}

export async function updatePost(workspaceId: string, postId: string, input: PostUpdateInput): Promise<PostDetail> {
  const row = await loadRow(workspaceId, postId);
  if (row.version !== input.version) throw new ContentError(409, "Post boshqa joyda o'zgartirilgan — sahifani yangilang");
  if (!EDITABLE.includes(row.status)) {
    throw new ContentError(409, row.status === "PUBLISHING" || row.status === "PREPARING" || row.status === "READY_TO_PUBLISH" ? "Post chiqarilmoqda — hozir tahrirlab bo'lmaydi" : "Bu holatdagi postni tahrirlab bo'lmaydi");
  }
  const type = input.type ?? row.type;
  if (input.instagramAccountId && input.instagramAccountId !== row.instagramAccountId) await ownedAccount(workspaceId, input.instagramAccountId);

  const nextMedia = input.media ?? inputOfRow(row).media;
  const facts = await ownedMedia(workspaceId, [...nextMedia.map((m) => m.mediaId), ...(input.coverMediaId ? [input.coverMediaId] : [])]);
  const merged: PostInput = { ...inputOfRow(row), ...input, type, media: nextMedia };
  const hard = hardIssues(merged, facts);
  if (hard.length) throw new ContentError(400, hard[0].message);
  // A post that already holds a slot must stay publishable.
  if (row.status === "SCHEDULED" || row.status === "PAUSED") {
    const issues = validatePost(merged, [...facts.values()], validateOpts(undefined, false));
    if (issues.length) throw new ContentError(400, issues[0].message);
  }

  const updated = await prisma.scheduledPost.updateMany({
    where: { id: postId, version: input.version },
    data: {
      ...(input.instagramAccountId ? { instagramAccountId: input.instagramAccountId } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...scalarData(input, type),
      version: { increment: 1 },
    },
  });
  if (updated.count === 0) throw new ContentError(409, "Post boshqa joyda o'zgartirilgan — sahifani yangilang");
  if (input.media) {
    await prisma.scheduledPostMedia.deleteMany({ where: { postId } });
    if (input.media.length) await prisma.scheduledPostMedia.createMany({ data: mediaRows(postId, input.media) });
    await reprepareCleanedMedia(workspaceId, input.media.map((m) => m.mediaId));
  }
  if (input.linkCampaign !== undefined) await attachCampaignToPost(workspaceId, postId, input.linkCampaign);
  // FR-A3: an edit voids the review — a pending or approved post goes back to DRAFT (old reviews stay as history, their postVersion no longer matches).
  if (row.status === "PENDING_REVIEW" || (row.reviewSubmittedAt && (row.status === "SCHEDULED" || row.status === "PAUSED"))) {
    await prisma.scheduledPost.updateMany({ where: { id: postId, status: row.status }, data: { status: "DRAFT", reviewRule: null, reviewSubmittedAt: null, version: { increment: 1 } } });
    if (row.status !== "PENDING_REVIEW") await removePostJobs(row.id, row.attempts);
    return getPost(workspaceId, postId);
  }
  await rearmIfNeeded(row, await loadRow(workspaceId, postId));
  return getPost(workspaceId, postId);
}

/** FR-L5 for an unsaved draft: the keywords of the campaign it is about to link (or create). */
export async function draftWarnings(workspaceId: string, input: PostInput): Promise<ValidationIssue[]> {
  const link = input.linkCampaign;
  if (!link) return [];
  let keywords: string[] = [];
  if (link.automationId) {
    keywords = (await prisma.automation.findFirst({ where: { id: link.automationId, workspaceId }, select: { keywords: true } }))?.keywords ?? [];
  } else if (link.triggerCampaignId) {
    keywords = (await prisma.triggerCampaign.findFirst({ where: { id: link.triggerCampaignId, workspaceId }, select: { keywords: true } }))?.keywords ?? [];
  } else if (link.create) {
    keywords = link.create.keywords;
  }
  return campaignKeywordWarnings(input.type, input.caption, keywords);
}

export async function validateDraft(workspaceId: string, input: PostInput): Promise<ValidationIssue[]> {
  const facts = await ownedMedia(workspaceId, input.media.map((m) => m.mediaId)).catch(() => new Map<string, MediaFacts>());
  return validatePost(input, [...facts.values()], validateOpts());
}

// ─── Scheduling ─────────────────────────────────────────────────────────────

export interface ScheduleOptions {
  now?: Date;
  /** publish-now / retry: the five-minute lead rule does not apply. */
  skipLeadCheck?: boolean;
}

/** FR-S4: one account, one minute — the second post moves two minutes later. */
async function spacedSlot(accountId: string, postId: string, at: Date): Promise<Date> {
  let slot = at;
  for (let i = 0; i < 100; i++) {
    const clash = await prisma.scheduledPost.findFirst({
      where: {
        instagramAccountId: accountId,
        id: { not: postId },
        deletedAt: null,
        status: { in: QUEUED },
        scheduledAt: { gte: new Date(slot.getTime() - 59_999), lte: new Date(slot.getTime() + 59_999) },
      },
      select: { id: true },
    });
    if (!clash) return slot;
    slot = new Date(slot.getTime() + CONTENT_LIMITS.sameMinuteGapMs);
  }
  return slot;
}

async function cas(postId: string, from: PostStatusValue[], data: Prisma.ScheduledPostUpdateManyMutationInput): Promise<void> {
  const r = await prisma.scheduledPost.updateMany({ where: { id: postId, status: { in: from } }, data: { ...data, version: { increment: 1 } } });
  if (r.count === 0) throw new ContentError(409, "Post holati o'zgarib ketdi — sahifani yangilang");
}

export async function schedulePost(workspaceId: string, postId: string, at: Date, opts: ScheduleOptions = {}): Promise<PostDetail> {
  const now = opts.now ?? new Date();
  const row = await loadRow(workspaceId, postId);
  if (row.status !== "SCHEDULED" && !canTransition(row.status, "SCHEDULED")) {
    throw new ContentError(409, "Bu holatdagi postni rejalashtirib bo'lmaydi");
  }
  if (row.type === "STORY" && row.media.length > 1) return scheduleStorySeries(workspaceId, row, at, opts);
  if (!opts.skipLeadCheck) {
    const when = scheduleIssues(at, now);
    if (when.length) throw new ContentError(400, when[0].message);
  }
  const issues = issuesOfRow(row, now);
  if (issues.length) throw new ContentError(400, issues.map((i) => i.message).join("; "));

  // Tariff: posts scheduled per month (phase 8). A post already out of DRAFT was counted.
  const { assertCanSchedule, PlanLimitError } = await import("@/lib/billing/limits");
  try {
    await assertCanSchedule(workspaceId, row.status !== "DRAFT", now);
  } catch (error) {
    if (error instanceof PlanLimitError) throw new ContentError(402, error.message, "PLAN_LIMIT");
    throw error;
  }

  const slot = await spacedSlot(row.instagramAccountId, row.id, at);
  const manual = !row.autoPublish || Boolean(row.manualReason);
  if (!manual) {
    const quota = await accountQuota(row.instagramAccountId, now);
    if (quotaWindowFull(quota)) {
      throw new ContentError(409, `24 soatlik limit to'ldi (${quota.used + quota.scheduledNext24h}/${quota.total}) — boshqa vaqt tanlang`, "PUBLISH_QUOTA");
    }
  }

  if (row.attempts > 0) await removePostJobs(row.id, row.attempts);
  const attempt = row.attempts + 1;
  await cas(row.id, [row.status], {
    status: "SCHEDULED",
    scheduledAt: slot,
    attempts: attempt,
    containerId: null,
    containerStatus: null,
    containerCreatedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  });

  await armJobs(row, attempt, slot, now);
  return getPost(workspaceId, postId);
}

/** The delayed jobs of one scheduling attempt: the manual notice, or prepare (30 / 60 min lead) + publish. */
async function armJobs(row: PostRow, attempt: number, slot: Date, now: Date): Promise<void> {
  if (!row.autoPublish || row.manualReason) {
    await scheduleManualNotify(row.id, attempt, slot);
    return;
  }
  const lead = isVideoType(row.type, row.media.map((m) => factsOf(m.media))) ? PREPARE_LEAD_MS.video : PREPARE_LEAD_MS.image;
  const prepareAt = new Date(Math.max(now.getTime(), slot.getTime() - lead));
  await schedulePrepare(row.id, attempt, prepareAt);
  await schedulePublish(row.id, attempt, slot);
}

/**
 * M8: editing a SCHEDULED post can change which jobs it needs — an image
 * swapped for a video needs the 60-minute prepare lead, a post switched to
 * manual needs the notice instead. Re-arm under a new attempt number so the
 * old jobs become stale.
 */
async function rearmIfNeeded(before: PostRow, after: PostRow, now: Date = new Date()): Promise<void> {
  if (after.status !== "SCHEDULED" || !after.scheduledAt) return;
  const wasVideo = isVideoType(before.type, before.media.map((m) => factsOf(m.media)));
  const isVideo = isVideoType(after.type, after.media.map((m) => factsOf(m.media)));
  const wasManual = !before.autoPublish || Boolean(before.manualReason);
  const isManual = !after.autoPublish || Boolean(after.manualReason);
  if (wasVideo === isVideo && wasManual === isManual && before.instagramAccountId === after.instagramAccountId) return;
  await removePostJobs(after.id, after.attempts);
  const attempt = after.attempts + 1;
  const r = await prisma.scheduledPost.updateMany({ where: { id: after.id, status: "SCHEDULED", attempts: after.attempts }, data: { attempts: attempt } });
  if (r.count === 0) return;
  await armJobs(after, attempt, after.scheduledAt, now);
}

/** FR-S2: one minute from now, with the usual checks except the lead time. */
export async function publishNow(workspaceId: string, postId: string, opts: ScheduleOptions = {}): Promise<PostDetail> {
  const now = opts.now ?? new Date();
  return schedulePost(workspaceId, postId, new Date(now.getTime() + 60_000), { now, skipLeadCheck: true });
}

export async function pausePost(workspaceId: string, postId: string): Promise<PostDetail> {
  const row = await loadRow(workspaceId, postId);
  if (!canTransition(row.status, "PAUSED")) throw new ContentError(409, "Faqat rejalashtirilgan postni pauza qilish mumkin");
  await cas(row.id, [row.status], { status: "PAUSED" });
  await removePostJobs(row.id, row.attempts);
  return getPost(workspaceId, postId);
}

export async function resumePost(workspaceId: string, postId: string, opts: ScheduleOptions = {}): Promise<PostDetail> {
  const row = await loadRow(workspaceId, postId);
  if (row.status !== "PAUSED") throw new ContentError(409, "Post pauzada emas");
  if (!row.scheduledAt) throw new ContentError(400, "Postda vaqt yo'q — qayta rejalashtiring");
  return schedulePost(workspaceId, postId, row.scheduledAt, opts);
}

export async function unschedulePost(workspaceId: string, postId: string): Promise<PostDetail> {
  const row = await loadRow(workspaceId, postId);
  if (!canTransition(row.status, "DRAFT")) throw new ContentError(409, "Bu holatdagi postni draftga qaytarib bo'lmaydi");
  await cas(row.id, [row.status], { status: "DRAFT", scheduledAt: null, containerId: null, containerStatus: null, containerCreatedAt: null });
  await removePostJobs(row.id, row.attempts);
  return getPost(workspaceId, postId);
}

export async function retryPost(workspaceId: string, postId: string, opts: ScheduleOptions = {}): Promise<PostDetail> {
  const now = opts.now ?? new Date();
  const row = await loadRow(workspaceId, postId);
  if (row.status !== "FAILED") throw new ContentError(409, "Faqat xato bo'lgan postni qayta urinish mumkin");
  const at = new Date(Math.max(row.scheduledAt?.getTime() ?? 0, now.getTime() + 60_000));
  return schedulePost(workspaceId, postId, at, { now, skipLeadCheck: true });
}

export async function cancelPost(workspaceId: string, postId: string): Promise<PostDetail> {
  const row = await loadRow(workspaceId, postId);
  if (!canTransition(row.status, "CANCELED")) throw new ContentError(409, "Bu holatdagi postni bekor qilib bo'lmaydi");
  await cas(row.id, [row.status], { status: "CANCELED" });
  await removePostJobs(row.id, row.attempts);
  await pauseLinkedCampaigns(row.id);
  return getPost(workspaceId, postId);
}

/** Soft delete (the Instagram post, if any, stays). */
export async function deletePost(workspaceId: string, postId: string): Promise<void> {
  const row = await loadRow(workspaceId, postId);
  if (row.status === "PUBLISHING") throw new ContentError(409, "Post chiqarilmoqda — birozdan keyin o'chiring");
  await prisma.scheduledPost.update({ where: { id: row.id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
  await removePostJobs(row.id, row.attempts);
  await pauseLinkedCampaigns(row.id);
}

export async function duplicatePost(workspaceId: string, postId: string, opts: { instagramAccountId?: string }): Promise<PostDetail> {
  const row = await loadRow(workspaceId, postId);
  const accountId = opts.instagramAccountId ?? row.instagramAccountId;
  if (accountId !== row.instagramAccountId) await ownedAccount(workspaceId, accountId);
  const input = inputOfRow(row);
  const created = await prisma.scheduledPost.create({
    data: {
      workspaceId,
      instagramAccountId: accountId,
      createdById: row.createdById ?? undefined,
      type: row.type,
      status: "DRAFT",
      timezone: row.timezone,
      ...scalarData(input, row.type),
    },
  });
  if (input.media.length) await prisma.scheduledPostMedia.createMany({ data: mediaRows(created.id, input.media) });
  await reprepareCleanedMedia(workspaceId, input.media.map((m) => m.mediaId));
  return getPost(workspaceId, created.id);
}

/** FR-N3: the user says they posted it themselves. */
export async function markPublishedManually(workspaceId: string, postId: string): Promise<PostDetail> {
  const row = await loadRow(workspaceId, postId);
  if (row.status !== "NEEDS_MANUAL") throw new ContentError(409, "Post qo'lda e'lon rejimida emas");
  await cas(row.id, ["NEEDS_MANUAL"], { status: "PUBLISHED_MANUAL", publishedAt: new Date() });
  return getPost(workspaceId, postId);
}

// ─── Listing ────────────────────────────────────────────────────────────────

export async function listPosts(workspaceId: string, q: PostsQuery): Promise<{ items: PostCard[]; total: number }> {
  const where: Prisma.ScheduledPostWhereInput = {
    workspaceId,
    deletedAt: null,
    ...(q.account ? { instagramAccountId: q.account } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(q.q ? { caption: { contains: q.q, mode: "insensitive" } } : {}),
    ...(q.unscheduled ? { scheduledAt: null } : q.from || q.to ? { scheduledAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
    ...(q.linked === "yes" ? { OR: [{ automations: { some: {} } }, { triggerCampaigns: { some: {} } }] } : {}),
    ...(q.linked === "no" ? { automations: { none: {} }, triggerCampaigns: { none: {} } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.scheduledPost.findMany({
      where,
      orderBy: [{ scheduledAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        instagramAccount: { select: { username: true } },
        // The card needs the first frame and the count, not every carousel item.
        media: { include: { media: { select: { thumbKey: true } } }, orderBy: { position: "asc" }, take: 1 },
        automations: { select: { id: true }, take: 1 },
        triggerCampaigns: { select: { id: true }, take: 1 },
        _count: { select: { media: true } },
      },
    }),
    prisma.scheduledPost.count({ where }),
  ]);
  const items = await Promise.all(
    rows.map(async (row) => {
      const first = row.media[0]?.media;
      return {
        id: row.id,
        instagramAccountId: row.instagramAccountId,
        accountUsername: row.instagramAccount?.username ?? null,
        type: row.type,
        status: row.status,
        caption: row.caption ? row.caption.slice(0, 120) : null,
        scheduledAt: row.scheduledAt,
        publishedAt: row.publishedAt,
        permalink: row.permalink,
        thumbUrl: first?.thumbKey ? await signedMediaUrl(first.thumbKey) : null,
        mediaCount: row._count?.media ?? row.media.length,
        linked: (row.automations?.length ?? 0) + (row.triggerCampaigns?.length ?? 0) > 0,
        autoPublish: row.autoPublish,
        lastErrorCode: row.lastErrorCode,
        version: row.version,
        seriesId: row.seriesId ?? null,
        seriesIndex: row.seriesIndex ?? null,
      };
    })
  );
  return { items, total };
}

// ─── Story series (FR-C9, AC-4) ─────────────────────────────────────────────

/**
 * A STORY draft with several media is split when it is scheduled, not when
 * it is created: the composer edits one draft, and every item that reaches
 * the queue is an ordinary one-media story. The original keeps media[0] and
 * becomes index 0; each further media gets its own post (index 1…n-1)
 * sharing a new seriesId, scheduled one minute after the previous item,
 * each with its own jobs. All checks run before anything is split.
 */
async function scheduleStorySeries(workspaceId: string, row: PostRow, at: Date, opts: ScheduleOptions): Promise<PostDetail> {
  const now = opts.now ?? new Date();
  if (!opts.skipLeadCheck) {
    const when = scheduleIssues(at, now);
    if (when.length) throw new ContentError(400, when[0].message);
  }
  const issues = issuesOfRow(row, now);
  if (issues.length) throw new ContentError(400, issues.map((i) => i.message).join("; "));
  const n = row.media.length;
  if (row.autoPublish && !row.manualReason) {
    const quota = await accountQuota(row.instagramAccountId, now);
    if (quotaWindowFull(quota, n)) {
      throw new ContentError(409, `24 soatlik limit ${n} ta story'ga yetmaydi (${quota.used + quota.scheduledNext24h}/${quota.total}) — boshqa vaqt tanlang`, "PUBLISH_QUOTA");
    }
  }

  const seriesId = randomUUID();
  const input = inputOfRow(row);
  const ids = [row.id];
  for (let i = 1; i < n; i++) {
    const created = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        instagramAccountId: row.instagramAccountId,
        createdById: row.createdById ?? undefined,
        type: "STORY",
        status: "DRAFT",
        timezone: row.timezone,
        seriesId,
        seriesIndex: i,
        ...scalarData(input, "STORY"),
      },
    });
    await prisma.scheduledPostMedia.createMany({ data: mediaRows(created.id, [input.media[i]]) });
    ids.push(created.id);
  }
  await prisma.scheduledPostMedia.deleteMany({ where: { postId: row.id, position: { gt: 0 } } });
  await prisma.scheduledPost.update({ where: { id: row.id }, data: { seriesId, seriesIndex: 0, version: { increment: 1 } } });

  let previous: Date | null = null;
  for (const id of ids) {
    const slot: Date = previous ? new Date(previous.getTime() + CONTENT_LIMITS.storySeriesGapMs) : at;
    const scheduled = await schedulePost(workspaceId, id, slot, { now, skipLeadCheck: previous ? true : opts.skipLeadCheck });
    previous = scheduled.scheduledAt ?? slot;
  }
  return getPost(workspaceId, row.id);
}
