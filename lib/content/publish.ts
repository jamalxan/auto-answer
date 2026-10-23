/**
 * ETAP 13 — the publish pipeline (spec §7 "Publish ketma-ketligi", §11).
 *
 *   preparePost   SCHEDULED → PREPARING → READY_TO_PUBLISH: token / scope /
 *                 media checks, signed URLs, one Meta container per media
 *                 (carousel children then the parent), status polling.
 *   publishPost   READY_TO_PUBLISH → PUBLISHING → PUBLISHED: the late rule,
 *                 the account lock, media_publish exactly once, permalink,
 *                 campaign activation in the same transaction, first-comment
 *                 and Telegram follow-ups.
 *   postFirstComment  the delayed comment, retried on its own.
 *
 * Idempotency: every status move is a compare-and-swap on status (and the
 * attempt number in the job must match the row), and a media_publish whose
 * answer was lost is resolved by asking Meta for the container's status
 * before any second call. `deps` exists for tests: the clock, the sleep.
 */

import { prisma } from "@/lib/db/client";
import { getUserMedia, type InstagramMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { createComment, createContainer, getContainerStatus, getPublishedMedia, publishContainer, type ContainerParams, type ContainerStatus } from "@/lib/meta/publish";
import { markTokenBroken } from "@/lib/meta/token-health";
import { alertWorkspace, notifyWorkspaceChats } from "@/lib/telegram/notify";
import { CONTAINER_MAX_WAIT_MS, CONTAINER_POLL_MS, FIRST_COMMENT_DELAY_MS, latePublishMaxMs, SIGNED_URL_TTL_SEC } from "./config";
import { classifyPublishError, isAmbiguousFailure, type PublishErrorCode } from "./errors";
import { activateLinkedCampaigns } from "./link-campaign";
import { withAccountLock } from "./lock";
import { signedMediaUrl } from "./media";
import { accountQuota, quotaWindowFull } from "./quota";
import { FIRST_COMMENT_JOB, PREPARE_JOB, PUBLISH_JOB, scheduleFirstComment, scheduleLockRetry, schedulePublish, scheduleRetry } from "./queue";
import type { PostStatusValue } from "./schema";
import { formatZoned } from "./time";

export interface PipelineDeps {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type PrepareResult =
  | { status: "READY_TO_PUBLISH"; containerId: string }
  | { skipped: string }
  | { waiting: "token" | "retry" }
  | { failed: PublishErrorCode };

export type PublishResult =
  | { status: "PUBLISHED"; igMediaId: string }
  | { skipped: string }
  | { waiting: "token" | "retry" | "lock" | "quota" }
  | { failed: PublishErrorCode };

export type RecoverResult = { status: "PUBLISHED"; igMediaId: string } | { status: "READY_TO_PUBLISH" } | { skipped: string } | { failed: PublishErrorCode };

const FIRST_COMMENT_RETRY_DELAYS = [30_000, 120_000];

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type UserTag = { username: string; x?: number; y?: number };

const POST_INCLUDE = {
  instagramAccount: true,
  media: { include: { media: true }, orderBy: { position: "asc" as const } },
};

async function loadPost(postId: string) {
  return prisma.scheduledPost.findUnique({ where: { id: postId }, include: POST_INCLUDE });
}
type PostRow = NonNullable<Awaited<ReturnType<typeof loadPost>>>;

async function attempt(postId: string, step: string, ok: boolean, extra: { message?: string; metaCode?: number; metaSubcode?: number; fbTraceId?: string; durationMs?: number } = {}) {
  await prisma.publishAttempt.create({
    data: { postId, step, ok, message: extra.message?.slice(0, 1000), metaCode: extra.metaCode, metaSubcode: extra.metaSubcode, fbTraceId: extra.fbTraceId, durationMs: extra.durationMs },
  });
}

function metaDetails(err: unknown) {
  const e = err as { code?: number; subcode?: number; fbTraceId?: string; message?: string };
  return { message: e?.message ?? String(err), metaCode: typeof e?.code === "number" ? e.code : undefined, metaSubcode: e?.subcode, fbTraceId: e?.fbTraceId };
}

/** Compare-and-swap of the status; false when someone else moved the row. */
async function move(postId: string, from: PostStatusValue[], data: Record<string, unknown>): Promise<boolean> {
  const r = await prisma.scheduledPost.updateMany({ where: { id: postId, status: { in: from } }, data: { ...data, version: { increment: 1 } } });
  return r.count > 0;
}

function postLabel(post: PostRow): string {
  const names: Record<string, string> = { FEED_IMAGE: "Post", FEED_VIDEO: "Video", CAROUSEL: "Karusel", REEL: "Reels", TRIAL_REEL: "Trial Reels", STORY: "Story" };
  return names[post.type] ?? post.type;
}

/** FAILED (or NEEDS_MANUAL) with the reason, the attempt row, the event and the owner's alert. */
export async function failPost(postId: string, code: PublishErrorCode, message: string, opts: { toManual?: boolean; step?: string } = {}): Promise<void> {
  const post = await loadPost(postId);
  if (!post) return;
  const next: PostStatusValue = opts.toManual ? "NEEDS_MANUAL" : "FAILED";
  const moved = await move(postId, ["SCHEDULED", "PREPARING", "READY_TO_PUBLISH", "PUBLISHING", "FAILED"], {
    status: next,
    lastErrorCode: code,
    lastErrorMessage: message.slice(0, 500),
    manualReason: opts.toManual ? "API_REJECTED" : post.manualReason,
  });
  await attempt(postId, opts.step ?? "PUBLISH", false, { message: `${code}: ${message}` });
  if (!moved) return;
  await prisma.operationalEvent.create({
    data: { workspaceId: post.workspaceId, source: "WORKER", level: "ERROR", message: `Content publish failed (${code}): ${message}`.slice(0, 500), payload: { postId, code } },
  }).catch(() => undefined);
  const label = postLabel(post);
  const when = post.scheduledAt ? formatZoned(post.scheduledAt, post.timezone) : "";
  await alertWorkspace(
    post.workspaceId,
    `${label} chiqmadi — @${post.instagramAccount.username}`,
    `❌ <b>${label} chiqmadi</b> (@${post.instagramAccount.username}${when ? `, ${when}` : ""})\n${message}\nSocialAuto → Kontent bo'limida postni oching.`,
    `${label} chiqmadi (@${post.instagramAccount.username}${when ? `, ${when}` : ""}). ${message}. SocialAuto → Kontent bo'limida postni oching.`
  ).catch(() => undefined);
}

/** Token BROKEN: the post waits in SCHEDULED; the sweeper fails it after the late window. */
async function waitForToken(post: PostRow, reason: string, from: PostStatusValue[]): Promise<void> {
  await move(post.id, from, { status: "SCHEDULED", lastErrorCode: "PUBLISH_TOKEN_EXPIRED", lastErrorMessage: reason.slice(0, 500) });
  await attempt(post.id, "CONTAINER", false, { message: `PUBLISH_TOKEN_EXPIRED: ${reason}` });
  if (post.lastErrorCode !== "PUBLISH_TOKEN_EXPIRED") {
    await alertWorkspace(
      post.workspaceId,
      `Instagram ulanishi uzildi — ${postLabel(post)} chiqmasligi mumkin`,
      `⚠️ <b>Instagram @${post.instagramAccount.username} ulanishi uzildi</b>\nRejalashtirilgan ${postLabel(post).toLowerCase()} chiqmasligi mumkin. Akkauntni 15 daqiqa ichida qayta ulang.`,
      `Instagram @${post.instagramAccount.username} ulanishi uzildi. Rejalashtirilgan post chiqmasligi mumkin — akkauntni 15 daqiqa ichida qayta ulang.`
    ).catch(() => undefined);
  }
}

// ─── Container building ─────────────────────────────────────────────────────

function tagsOf(raw: unknown): UserTag[] {
  return Array.isArray(raw) ? (raw as UserTag[]).filter((t) => t && typeof t.username === "string") : [];
}

async function urlOf(key: string | null | undefined): Promise<string> {
  if (!key) throw new Error("Media tayyor emas (fayl yo'q)");
  return signedMediaUrl(key, SIGNED_URL_TTL_SEC);
}

async function singleContainerParams(post: PostRow): Promise<ContainerParams> {
  const item = post.media[0];
  const asset = item.media;
  const url = await urlOf(asset.preparedKey ?? asset.originalKey);
  const isVideo = asset.kind === "VIDEO";
  const common: ContainerParams = {
    userTags: tagsOf(item.userTags).length ? tagsOf(item.userTags) : undefined,
    isAiGenerated: post.isAiGenerated || undefined,
  };
  if (post.type === "STORY") {
    return { ...common, ...(isVideo ? { videoUrl: url } : { imageUrl: url }), mediaType: "STORIES" };
  }
  const captioned: ContainerParams = {
    ...common,
    caption: post.caption ?? undefined,
    collaborators: post.collaborators.length ? post.collaborators : undefined,
    locationId: post.locationId ?? undefined,
  };
  if (post.type === "FEED_IMAGE" && !isVideo) {
    return { ...captioned, imageUrl: url, altText: item.altText ?? undefined };
  }
  // FEED_VIDEO / REEL / TRIAL_REEL (and a video that slipped into FEED_IMAGE): Reels.
  let coverUrl: string | undefined;
  if (post.coverMediaId) {
    const cover = await prisma.mediaAsset.findUnique({ where: { id: post.coverMediaId } });
    if (cover?.preparedKey) coverUrl = await urlOf(cover.preparedKey);
  }
  return {
    ...captioned,
    videoUrl: url,
    mediaType: "REELS",
    coverUrl,
    thumbOffsetMs: coverUrl ? undefined : (post.thumbOffsetMs ?? undefined),
    shareToFeed: post.type === "TRIAL_REEL" ? undefined : post.shareToFeed,
    audioName: post.audioName ?? undefined,
    trialStrategy: post.type === "TRIAL_REEL" ? ((post.trialStrategy as "MANUAL" | "SS_PERFORMANCE" | null) ?? "MANUAL") : undefined,
  };
}

async function carouselChildParams(item: PostRow["media"][number]): Promise<ContainerParams> {
  const asset = item.media;
  const url = await urlOf(asset.preparedKey ?? asset.originalKey);
  const tags = tagsOf(item.userTags);
  return {
    ...(asset.kind === "VIDEO" ? { videoUrl: url } : { imageUrl: url, altText: item.altText ?? undefined }),
    isCarouselItem: true,
    userTags: tags.length ? tags : undefined,
  };
}

function carouselParentParams(post: PostRow, children: string[]): ContainerParams {
  return {
    mediaType: "CAROUSEL",
    children,
    caption: post.caption ?? undefined,
    collaborators: post.collaborators.length ? post.collaborators : undefined,
    locationId: post.locationId ?? undefined,
    isAiGenerated: post.isAiGenerated || undefined,
  };
}

// ─── Status polling ─────────────────────────────────────────────────────────

type PollOutcome = { outcome: "FINISHED" | "PUBLISHED" } | { outcome: "ERROR"; text: string } | { outcome: "EXPIRED" } | { outcome: "TIMEOUT" };

async function waitForContainer(token: string, postId: string, containerId: string, maxWaitMs: number, deps: Required<PipelineDeps>): Promise<PollOutcome> {
  const started = deps.now().getTime();
  for (;;) {
    const t0 = deps.now().getTime();
    const { status, statusText } = await getContainerStatus(token, containerId);
    await attempt(postId, "STATUS", status !== "ERROR", { message: `${containerId}: ${status}${statusText ? ` — ${statusText}` : ""}`, durationMs: deps.now().getTime() - t0 });
    const s: ContainerStatus = status;
    if (s === "FINISHED" || s === "PUBLISHED") return { outcome: s };
    if (s === "ERROR") return { outcome: "ERROR", text: statusText ?? "" };
    if (s === "EXPIRED") return { outcome: "EXPIRED" };
    if (deps.now().getTime() - started >= maxWaitMs) return { outcome: "TIMEOUT" };
    await deps.sleep(CONTAINER_POLL_MS);
  }
}

// ─── prepare ────────────────────────────────────────────────────────────────

/**
 * Create the Meta container(s) for the post and wait until Meta has
 * processed them. Leaves the row READY_TO_PUBLISH, SCHEDULED (waiting on
 * a token or a retry) or FAILED.
 */
export async function preparePost(postId: string, attemptNo: number, depsIn: PipelineDeps = {}, retryNo = 0): Promise<PrepareResult> {
  const deps: Required<PipelineDeps> = { now: depsIn.now ?? (() => new Date()), sleep: depsIn.sleep ?? defaultSleep };
  const post = await loadPost(postId);
  if (!post || post.deletedAt) return { skipped: "missing" };
  if (post.attempts !== attemptNo) return { skipped: "stale" };
  if (post.status === "READY_TO_PUBLISH" && post.containerId) return { status: "READY_TO_PUBLISH", containerId: post.containerId };
  if (post.status !== "SCHEDULED") return { skipped: `status ${post.status}` };
  if (!post.autoPublish || post.manualReason) return { skipped: "manual" };

  // Pre-flight (FR-P2)
  if (post.instagramAccount.tokenStatus !== "ACTIVE") {
    await waitForToken(post, post.instagramAccount.tokenLastError ?? "Instagram ulanishi uzilgan", ["SCHEDULED"]);
    return { waiting: "token" };
  }
  if (!post.instagramAccount.canPublish) {
    await failPost(postId, "PUBLISH_NO_PERMISSION", "Post chiqarish ruxsati berilmagan — Instagram akkauntni qayta ulang", { step: "CONTAINER" });
    return { failed: "PUBLISH_NO_PERMISSION" };
  }
  if (post.media.length === 0 || post.media.some((m) => m.media.status !== "READY")) {
    await failPost(postId, "PUBLISH_MEDIA_INVALID", "Media tayyor emas — fayl hali qayta ishlanmagan yoki xato bilan tugagan", { step: "CONTAINER" });
    return { failed: "PUBLISH_MEDIA_INVALID" };
  }

  if (!(await move(postId, ["SCHEDULED"], { status: "PREPARING" }))) return { skipped: "race" };
  const token = decryptToken(post.instagramAccount.accessToken);
  const igId = post.instagramAccount.instagramId;
  const isVideo = post.media.some((m) => m.media.kind === "VIDEO");
  const maxWait = isVideo ? CONTAINER_MAX_WAIT_MS.video : CONTAINER_MAX_WAIT_MS.image;

  const createOne = async (params: ContainerParams, label: string): Promise<string> => {
    const t0 = deps.now().getTime();
    try {
      const { id } = await createContainer(token, igId, params);
      await attempt(postId, "CONTAINER", true, { message: `${label} → ${id}`, durationMs: deps.now().getTime() - t0 });
      return id;
    } catch (error) {
      await attempt(postId, "CONTAINER", false, { ...metaDetails(error), durationMs: deps.now().getTime() - t0 });
      throw error;
    }
  };

  // One full pass: build everything and wait. `fresh` = second pass after EXPIRED / TIMEOUT.
  const build = async (): Promise<{ containerId: string } | PollOutcome> => {
    let parentId: string;
    if (post.type === "CAROUSEL") {
      const childIds: string[] = [];
      for (const item of post.media) {
        const id = await createOne(await carouselChildParams(item), `child ${item.position}`);
        childIds.push(id);
        await prisma.scheduledPostMedia.update({ where: { id: item.id }, data: { containerId: id } });
        if (item.media.kind === "VIDEO") {
          const r = await waitForContainer(token, postId, id, maxWait, deps);
          if (r.outcome !== "FINISHED" && r.outcome !== "PUBLISHED") return r;
        }
      }
      parentId = await createOne(carouselParentParams(post, childIds), "carousel");
    } else {
      parentId = await createOne(await singleContainerParams(post), post.type);
    }
    await prisma.scheduledPost.update({ where: { id: postId }, data: { containerId: parentId, containerStatus: "IN_PROGRESS", containerCreatedAt: deps.now() } });
    const r = await waitForContainer(token, postId, parentId, maxWait, deps);
    if (r.outcome === "FINISHED" || r.outcome === "PUBLISHED") return { containerId: parentId };
    return r;
  };

  try {
    let result = await build();
    if ("outcome" in result && (result.outcome === "EXPIRED" || result.outcome === "TIMEOUT")) {
      // Spec §11: one more container, then give up.
      result = await build();
    }
    if ("containerId" in result) {
      await move(postId, ["PREPARING"], { status: "READY_TO_PUBLISH", containerId: result.containerId, containerStatus: "FINISHED", lastErrorCode: null, lastErrorMessage: null });
      // The slot already passed (late prepare, retry backoff): nothing is waiting to publish — queue it now.
      if (post.scheduledAt && post.scheduledAt.getTime() <= deps.now().getTime()) await schedulePublish(postId, attemptNo, deps.now());
      return { status: "READY_TO_PUBLISH", containerId: result.containerId };
    }
    if (result.outcome === "ERROR") {
      const cls = classifyPublishError(new Error(result.text), result.text);
      const code: PublishErrorCode = cls.code === "PUBLISH_UNKNOWN" ? "PUBLISH_MEDIA_INVALID" : cls.code;
      await failPost(postId, code, result.text ? `Instagram faylni qabul qilmadi: ${result.text}` : "Instagram faylni qabul qilmadi", { step: "STATUS" });
      return { failed: code };
    }
    const code: PublishErrorCode = result.outcome === "TIMEOUT" ? "PUBLISH_CONTAINER_TIMEOUT" : "PUBLISH_CONTAINER_EXPIRED";
    await failPost(postId, code, "Instagram videoni qayta ishlay olmadi — qaytadan urinib ko'ring yoki qo'lda chiqaring", { step: "STATUS" });
    return { failed: code };
  } catch (error) {
    return handlePrepareError(post, error, retryNo);
  }
}

async function handlePrepareError(post: PostRow, error: unknown, retryNo: number): Promise<PrepareResult> {
  const cls = classifyPublishError(error);
  const details = metaDetails(error);
  if (cls.code === "PUBLISH_TOKEN_EXPIRED") {
    await markTokenBroken(post.instagramAccountId, details.message).catch(() => undefined);
    await waitForToken(post, details.message, ["PREPARING"]);
    return { waiting: "token" };
  }
  if (cls.code === "PUBLISH_NO_PERMISSION") {
    await prisma.instagramAccount.update({ where: { id: post.instagramAccountId }, data: { canPublish: false } }).catch(() => undefined);
    await failPost(post.id, cls.code, "Post chiqarish ruxsati berilmagan — Instagram akkauntni qayta ulang", { step: "CONTAINER" });
    return { failed: cls.code };
  }
  if ((cls.retry === "backoff" || cls.retry === "new-url") && retryNo < cls.delaysMs.length) {
    await move(post.id, ["PREPARING"], { status: "SCHEDULED", lastErrorCode: cls.code, lastErrorMessage: details.message.slice(0, 500), containerId: null, containerStatus: null });
    await scheduleRetry(PREPARE_JOB, post.id, post.attempts, retryNo + 1, cls.delaysMs[retryNo]);
    return { waiting: "retry" };
  }
  const human: Partial<Record<PublishErrorCode, string>> = {
    PUBLISH_QUOTA: "24 soatlik limit to'ldi — postni boshqa vaqtga ko'chiring",
    PUBLISH_MEDIA_FETCH: "Instagram faylni yuklab ololmadi",
    PUBLISH_INVALID_USER_TAG: "Belgilangan foydalanuvchi topilmadi yoki yopiq akkaunt",
    PUBLISH_INVALID_COLLABORATOR: "Hammuallif topilmadi yoki yopiq akkaunt",
    PUBLISH_PPA_REQUIRED: "Instagram ilovasida tasdiqlash talab qilinmoqda",
    PUBLISH_ACCOUNT_RESTRICTED: "Akkaunt API orqali post qila olmaydi — avval ilovadan qo'lda post qilib ko'ring",
    PUBLISH_MEDIA_INVALID: "Instagram faylni qabul qilmadi",
  };
  await failPost(post.id, cls.code, `${human[cls.code] ?? "Vaqtinchalik xato"}: ${details.message}`.slice(0, 500), { step: "CONTAINER", toManual: cls.retry === "manual" });
  return { failed: cls.code };
}

// ─── publish ────────────────────────────────────────────────────────────────

/** The newest media of the account that could be the one Meta published for us (lost media_publish answer). */
async function findJustPublished(token: string, post: PostRow, since: Date): Promise<InstagramMedia | null> {
  const list = await getUserMedia(token, 10).catch(() => [] as InstagramMedia[]);
  const wantsVideo = post.media.some((m) => m.media.kind === "VIDEO");
  const candidates = list.filter((m) => {
    const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
    if (ts && ts < since.getTime() - 5 * 60_000) return false;
    if (post.type === "CAROUSEL") return m.media_type === "CAROUSEL_ALBUM";
    if (wantsVideo) return m.media_type === "VIDEO";
    return m.media_type === "IMAGE";
  });
  return candidates[0] ?? null;
}

export async function publishPost(postId: string, attemptNo: number, depsIn: PipelineDeps = {}, retryNo = 0): Promise<PublishResult> {
  const deps: Required<PipelineDeps> = { now: depsIn.now ?? (() => new Date()), sleep: depsIn.sleep ?? defaultSleep };
  let post = await loadPost(postId);
  if (!post || post.deletedAt) return { skipped: "missing" };
  if (post.attempts !== attemptNo) return { skipped: "stale" };
  if (!post.autoPublish || post.manualReason) return { skipped: "manual" };

  // The prepare job did not run (sweeper re-queue, short lead): do it now.
  if (post.status === "SCHEDULED") {
    const prepared = await preparePost(postId, attemptNo, depsIn, retryNo);
    if (!("status" in prepared)) return "waiting" in prepared ? { waiting: prepared.waiting } : "failed" in prepared ? { failed: prepared.failed } : { skipped: prepared.skipped };
    post = (await loadPost(postId))!;
  }
  if (post.status !== "READY_TO_PUBLISH" || !post.containerId) return { skipped: `status ${post.status}` };

  // The late rule (spec §7): never surprise the owner with an old post.
  const now = deps.now();
  if (post.scheduledAt && now.getTime() - post.scheduledAt.getTime() > latePublishMaxMs()) {
    await failPost(postId, "PUBLISH_LATE", "Vaqt o'tib ketdi — post avtomatik chiqarilmadi. Hozir chiqaraymi? (Qayta urinish)", { step: "PUBLISH" });
    return { failed: "PUBLISH_LATE" };
  }

  const locked = await withAccountLock(post.instagramAccountId, async (): Promise<PublishResult> => {
    if (!(await move(postId, ["READY_TO_PUBLISH"], { status: "PUBLISHING" }))) return { skipped: "race" };
    const row = (await loadPost(postId))!;
    const token = decryptToken(row.instagramAccount.accessToken);
    const igId = row.instagramAccount.instagramId;

    // Quota (FR-P2); cached, so this is cheap.
    const quota = await accountQuota(row.instagramAccountId, now).catch(() => null);
    if (quota && quota.source === "api" && quota.used >= quota.total) {
      return rescheduleForQuota(row, quota.resetsAt ?? new Date(now.getTime() + 3_600_000), ["PUBLISHING"]);
    }

    const t0 = now.getTime();
    let igMediaId: string | null = null;
    let permalink: string | undefined;
    try {
      const r = await publishContainer(token, igId, row.containerId!);
      igMediaId = r.id;
      await attempt(postId, "PUBLISH", true, { message: `media ${r.id}`, durationMs: deps.now().getTime() - t0 });
    } catch (error) {
      await attempt(postId, "PUBLISH", false, { ...metaDetails(error), durationMs: deps.now().getTime() - t0 });
      if (isAmbiguousFailure(error)) {
        // Did it actually go out? Ask for the container before any second call.
        const status = await getContainerStatus(token, row.containerId!).catch(() => null);
        if (status?.status === "PUBLISHED") {
          const found = await findJustPublished(token, row, row.scheduledAt ?? now);
          if (found) {
            igMediaId = found.id;
            permalink = found.permalink;
          } else {
            await failPost(postId, "PUBLISH_UNKNOWN", "Instagram postni chiqardi, lekin uning ID si topilmadi — Instagram'da tekshiring va kampaniyani qo'lda ulang", { step: "PUBLISH" });
            return { failed: "PUBLISH_UNKNOWN" };
          }
        }
      }
      if (!igMediaId) return handlePublishError(row, error, retryNo, now);
    }

    return finishPublished(row, igMediaId, permalink, deps);
  });

  if (!locked.acquired) {
    await scheduleLockRetry(postId, attemptNo, retryNo, 15_000);
    return { waiting: "lock" };
  }
  return locked.result;
}

/** Meta has the media: record PUBLISHED, activate the campaign in the same transaction (FR-L3), queue the first comment, tell the chats. */
async function finishPublished(row: PostRow, igMediaId: string, permalinkIn: string | undefined, deps: Required<PipelineDeps>): Promise<{ status: "PUBLISHED"; igMediaId: string }> {
  const postId = row.id;
  let permalink = permalinkIn;
  if (!permalink) {
    const media = await getPublishedMedia(decryptToken(row.instagramAccount.accessToken), igMediaId).catch(() => null);
    permalink = media?.permalink;
  }

  // One transaction: the post is PUBLISHED and its campaign is live before the first comment can arrive (FR-L3).
  let linked = { automations: 0, triggers: 0 };
  try {
    await prisma.$transaction(async (tx) => {
      await tx.scheduledPost.update({
        where: { id: postId },
        data: { status: "PUBLISHED", igMediaId, permalink: permalink ?? null, publishedAt: deps.now(), containerStatus: "PUBLISHED", lastErrorCode: null, lastErrorMessage: null, version: { increment: 1 } },
      });
      linked = await activateLinkedCampaigns(tx, postId, igMediaId);
    });
    await attempt(postId, "LINK_CAMPAIGN", true, { message: `automations ${linked.automations}, triggers ${linked.triggers}` });
  } catch (error) {
    // The publish happened; record it even if the campaign link failed, and shout.
    const message = error instanceof Error ? error.message : String(error);
    await prisma.scheduledPost.update({ where: { id: postId }, data: { status: "PUBLISHED", igMediaId, permalink: permalink ?? null, publishedAt: deps.now(), lastErrorCode: "CAMPAIGN_LINK_FAILED", lastErrorMessage: message.slice(0, 500), version: { increment: 1 } } }).catch(() => undefined);
    await attempt(postId, "LINK_CAMPAIGN", false, { message });
    await alertWorkspace(row.workspaceId, "Kampaniya ulanmadi", `⚠️ <b>Post chiqdi, lekin kampaniya ulanmadi</b> — DM lar yo'qolishi mumkin. Kampaniyani qo'lda ulang.`, "Post chiqdi, lekin kampaniya ulanmadi — DM lar yo'qolishi mumkin. Kampaniyani qo'lda ulang.").catch(() => undefined);
  }

  if (row.firstComment?.trim()) await scheduleFirstComment(postId, FIRST_COMMENT_DELAY_MS);
  await notifyWorkspaceChats(
    row.workspaceId,
    `✅ <b>${postLabel(row)} chiqdi</b> — @${row.instagramAccount.username}${permalink ? `\n${permalink}` : ""}${linked.automations + linked.triggers > 0 ? "\nComment-to-DM kampaniyasi ulandi." : ""}`
  ).catch(() => 0);
  return { status: "PUBLISHED", igMediaId };
}

/**
 * A worker died between PUBLISHING and the final update (deploy, crash): the
 * sweeper hands such rows here after five quiet minutes. Meta is asked what
 * became of the container — never a second media_publish (FR-P5).
 */
export async function recoverStuckPublishing(postId: string, depsIn: PipelineDeps = {}): Promise<RecoverResult> {
  const deps: Required<PipelineDeps> = { now: depsIn.now ?? (() => new Date()), sleep: depsIn.sleep ?? defaultSleep };
  const post = await loadPost(postId);
  if (!post || post.deletedAt) return { skipped: "missing" };
  if (post.status !== "PUBLISHING") return { skipped: `status ${post.status}` };
  if (!post.containerId) {
    await failPost(postId, "PUBLISH_UNKNOWN", "Chiqarish jarayoni uzilib qoldi — qayta urinib ko'ring", { step: "PUBLISH" });
    return { failed: "PUBLISH_UNKNOWN" };
  }
  const token = decryptToken(post.instagramAccount.accessToken);
  const status = await getContainerStatus(token, post.containerId).catch(() => null);
  await attempt(postId, "STATUS", Boolean(status), { message: `recover after a halted publish: ${status?.status ?? "no answer"}` });
  if (status?.status === "PUBLISHED") {
    const found = await findJustPublished(token, post, post.scheduledAt ?? deps.now());
    if (!found) {
      await failPost(postId, "PUBLISH_UNKNOWN", "Instagram postni chiqardi, lekin uning ID si topilmadi — Instagram'da tekshiring va kampaniyani qo'lda ulang", { step: "PUBLISH" });
      return { failed: "PUBLISH_UNKNOWN" };
    }
    return finishPublished(post, found.id, found.permalink, deps);
  }
  if (status?.status === "FINISHED") {
    await move(postId, ["PUBLISHING"], { status: "READY_TO_PUBLISH" });
    await schedulePublish(postId, post.attempts, deps.now());
    return { status: "READY_TO_PUBLISH" };
  }
  await failPost(postId, "PUBLISH_UNKNOWN", `Chiqarish jarayoni uzilib qoldi (konteyner: ${status?.status ?? "javob yo'q"}) — qayta urinib ko'ring`, { step: "PUBLISH" });
  return { failed: "PUBLISH_UNKNOWN" };
}

async function rescheduleForQuota(post: PostRow, at: Date, from: PostStatusValue[]): Promise<PublishResult> {
  const slot = new Date(Math.max(at.getTime(), Date.now() + 60_000));
  // A fresh attempt number: the job that just ran owns the old id, and BullMQ would ignore a re-add under it.
  await move(post.id, from, { status: "SCHEDULED", scheduledAt: slot, attempts: { increment: 1 }, lastErrorCode: "PUBLISH_QUOTA", lastErrorMessage: `24 soatlik limit to'ldi — ${formatZoned(slot, post.timezone)} ga ko'chirildi`, containerId: null, containerStatus: null, containerCreatedAt: null });
  await schedulePublish(post.id, post.attempts + 1, slot);
  await alertWorkspace(
    post.workspaceId,
    "24 soatlik post limiti to'ldi",
    `⏳ <b>24 soatlik post limiti to'ldi</b> — ${postLabel(post)} ${formatZoned(slot, post.timezone)} ga ko'chirildi.`,
    `24 soatlik post limiti to'ldi — post ${formatZoned(slot, post.timezone)} ga ko'chirildi.`
  ).catch(() => undefined);
  return { waiting: "quota" };
}

async function handlePublishError(post: PostRow, error: unknown, retryNo: number, now: Date): Promise<PublishResult> {
  const cls = classifyPublishError(error);
  const details = metaDetails(error);
  if (cls.code === "PUBLISH_TOKEN_EXPIRED") {
    await markTokenBroken(post.instagramAccountId, details.message).catch(() => undefined);
    await move(post.id, ["PUBLISHING"], { status: "READY_TO_PUBLISH", lastErrorCode: cls.code, lastErrorMessage: details.message.slice(0, 500) });
    return { waiting: "token" };
  }
  if (cls.code === "PUBLISH_QUOTA") {
    const quota = await accountQuota(post.instagramAccountId, now).catch(() => null);
    return rescheduleForQuota(post, quota?.resetsAt ?? new Date(now.getTime() + 3_600_000), ["PUBLISHING"]);
  }
  if (cls.code === "PUBLISH_NO_PERMISSION") {
    await prisma.instagramAccount.update({ where: { id: post.instagramAccountId }, data: { canPublish: false } }).catch(() => undefined);
    await failPost(post.id, cls.code, "Post chiqarish ruxsati berilmagan — Instagram akkauntni qayta ulang");
    return { failed: cls.code };
  }
  if (cls.retry === "backoff" && retryNo < cls.delaysMs.length) {
    await move(post.id, ["PUBLISHING"], { status: "READY_TO_PUBLISH", lastErrorCode: cls.code, lastErrorMessage: details.message.slice(0, 500) });
    await scheduleRetry(PUBLISH_JOB, post.id, post.attempts, retryNo + 1, cls.delaysMs[retryNo]);
    return { waiting: "retry" };
  }
  if (cls.code === "PUBLISH_CONTAINER_EXPIRED" || /expired/i.test(details.message)) {
    await move(post.id, ["PUBLISHING"], { status: "SCHEDULED", containerId: null, containerStatus: null, containerCreatedAt: null });
    await scheduleRetry(PREPARE_JOB, post.id, post.attempts, retryNo + 1, 1_000);
    return { waiting: "retry" };
  }
  await failPost(post.id, cls.code, `Vaqtinchalik xato: ${details.message}`.slice(0, 500), { toManual: cls.retry === "manual" });
  return { failed: cls.code };
}

// ─── first comment ──────────────────────────────────────────────────────────

export async function postFirstComment(postId: string, depsIn: PipelineDeps = {}, retryNo = 0): Promise<{ sent: boolean } | { skipped: string }> {
  const deps: Required<PipelineDeps> = { now: depsIn.now ?? (() => new Date()), sleep: depsIn.sleep ?? defaultSleep };
  const post = await loadPost(postId);
  if (!post || post.status !== "PUBLISHED" || !post.igMediaId) return { skipped: "not published" };
  if (!post.firstComment?.trim()) return { skipped: "no comment" };
  if (post.firstCommentStatus === "SENT") return { skipped: "already sent" };
  const token = decryptToken(post.instagramAccount.accessToken);
  const t0 = deps.now().getTime();
  try {
    const { id } = await createComment(token, post.igMediaId, post.firstComment.trim());
    await prisma.scheduledPost.update({ where: { id: postId }, data: { firstCommentStatus: "SENT", firstCommentId: id } });
    await attempt(postId, "COMMENT", true, { message: `comment ${id}`, durationMs: deps.now().getTime() - t0 });
    return { sent: true };
  } catch (error) {
    await attempt(postId, "COMMENT", false, { ...metaDetails(error), durationMs: deps.now().getTime() - t0 });
    if (retryNo < FIRST_COMMENT_RETRY_DELAYS.length) {
      await scheduleFirstComment(postId, FIRST_COMMENT_RETRY_DELAYS[retryNo], retryNo + 1);
      return { sent: false };
    }
    const message = metaDetails(error).message;
    await prisma.scheduledPost.update({ where: { id: postId }, data: { firstCommentStatus: "FAILED", lastErrorCode: "FIRST_COMMENT_FAILED", lastErrorMessage: message.slice(0, 500) } });
    await alertWorkspace(
      post.workspaceId,
      "Birinchi komment yozilmadi",
      `⚠️ <b>Post chiqdi, birinchi komment yozilmadi</b> — @${post.instagramAccount.username}. Kontent bo'limida qayta urinib ko'ring.`,
      `Post chiqdi, birinchi komment yozilmadi (@${post.instagramAccount.username}). Kontent bo'limida qayta urinib ko'ring.`
    ).catch(() => undefined);
    return { sent: false };
  }
}

export { FIRST_COMMENT_JOB };
