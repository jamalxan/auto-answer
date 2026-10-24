/**
 * ETAP 13 Faza 2 — CSV import, the service half (FR-I1, FR-I2).
 *
 *   previewCsvImport(ws, csv)              no writes: every row normalized and judged
 *   commitCsvImport(ws, user, csv, rows)   the rows the user ticked; refuses the
 *                                          whole request when any of them still
 *                                          has an error (nothing is imported
 *                                          silently); per row: media fetched into
 *                                          the library, kinds re-checked, DRAFT
 *                                          created, campaign linked
 *   scheduleImportedPosts(ws, postIds)     the imported drafts that asked for a
 *                                          slot, once their media are READY
 *
 * Why scheduling is a second step: downloaded media go through the normal
 * media-process job (sharp / ffmpeg) and schedulePost refuses media that is
 * not READY. The draft keeps the requested time in `scheduledAt` (a DRAFT's
 * scheduledAt is only a plan — no job is armed), the import screen calls
 * the schedule step until every post is scheduled or reported.
 */

import { prisma } from "@/lib/db/client";
import { carouselMaxItems, maxCollaborators } from "./config";
import { normalizeCsv, CsvError, resolveType, rowIssues, rowToPostInput, type CsvCampaign, type CsvContext, type CsvPreview, type CsvRow, type MediaKindValue } from "./csv";
import { ContentError } from "./errors";
import { attachCampaignToPost } from "./link-campaign";
import { deleteMedia } from "./media";
import { importMediaFromUrl, type MediaImportDeps } from "./media-import";
import { createPost, getPost, schedulePost } from "./service";
import { DEFAULT_TIMEZONE } from "./time";

/** One commit fetches at most this many files (media + covers). */
export const COMMIT_MAX_FILES = 200;
const FETCH_CONCURRENCY = 3;

async function loadContext(workspaceId: string, now: Date): Promise<CsvContext> {
  const [workspace, accounts, automations, triggers] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } }),
    prisma.instagramAccount.findMany({ where: { workspaceId }, select: { id: true, username: true, canPublish: true } }),
    prisma.automation.findMany({ where: { workspaceId }, take: 500, select: { id: true, name: true, instagramAccountId: true, keywords: true, isActive: true, postId: true, scheduledPostId: true } }),
    prisma.triggerCampaign.findMany({
      where: { workspaceId, triggerType: "COMMENT", kind: "CAMPAIGN" },
      take: 500,
      select: { id: true, name: true, instagramAccountId: true, keywords: true, active: true, mediaIds: true, scheduledPostId: true },
    }),
  ]);
  const campaigns: CsvCampaign[] = [
    ...automations.map((a) => ({ kind: "automation" as const, id: a.id, name: a.name, instagramAccountId: a.instagramAccountId ?? "", keywords: a.keywords ?? [], live: Boolean(a.isActive && a.postId) })),
    ...triggers.map((t) => ({ kind: "trigger" as const, id: t.id, name: t.name, instagramAccountId: t.instagramAccountId ?? "", keywords: t.keywords ?? [], live: Boolean(t.active && (t.mediaIds?.length ?? 0) > 0) })),
  ];
  return {
    accounts: accounts.map((a) => ({ id: a.id, username: a.username ?? "", canPublish: a.canPublish === true })),
    campaigns,
    timezone: workspace?.timezone || DEFAULT_TIMEZONE,
    now,
    carouselMax: carouselMaxItems(),
    maxCollaborators: maxCollaborators(),
  };
}

export async function previewCsvImport(workspaceId: string, csv: string, now: Date = new Date()): Promise<CsvPreview> {
  const ctx = await loadContext(workspaceId, now);
  try {
    return normalizeCsv(csv, ctx);
  } catch (error) {
    if (error instanceof CsvError) throw new ContentError(400, error.message);
    throw error;
  }
}

export interface CommitRowResult {
  row: number;
  ok: boolean;
  postId?: string;
  error?: string;
  warnings: string[];
  /** The row asked for a slot (draft=0): the schedule step will place it. */
  wantsSchedule: boolean;
  scheduledAt: string | null;
}

export interface CommitResult {
  results: CommitRowResult[];
  created: number;
  failed: number;
  /** Post ids to pass to scheduleImportedPosts. */
  toSchedule: string[];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function releaseMedia(workspaceId: string, ids: string[]): Promise<void> {
  for (const id of ids) await deleteMedia(workspaceId, id).catch(() => undefined);
}

async function commitRow(workspaceId: string, userId: string | null, row: CsvRow, ctx: CsvContext, deps: MediaImportDeps): Promise<CommitRowResult> {
  const base = { row: row.row, warnings: [...row.warnings], wantsSchedule: !row.draft && Boolean(row.scheduledAt), scheduledAt: row.scheduledAt };
  const fetched: string[] = [];
  try {
    const urls = [...row.media.map((m) => m.url), ...(row.coverUrl ? [row.coverUrl] : [])];
    const settled = await mapLimit(urls, FETCH_CONCURRENCY, async (url, i) => {
      try {
        const media = await importMediaFromUrl(workspaceId, userId, url, deps);
        fetched.push(media.mediaId);
        return { ok: true as const, media };
      } catch (error) {
        const label = i < row.media.length ? `media_url_${i + 1}` : "cover_url";
        return { ok: false as const, error: `${label}: ${error instanceof ContentError ? error.message : "fayl yuklab olinmadi"}` };
      }
    });
    const failures = settled.filter((s) => !s.ok).map((s) => (s as { error: string }).error);
    if (failures.length) throw new ContentError(400, failures.join("; "));
    const imported = settled.map((s) => (s as { media: { mediaId: string; kind: MediaKindValue } }).media);
    const media = imported.slice(0, row.media.length);
    const cover = row.coverUrl ? imported[row.media.length] : null;
    if (cover && cover.kind !== "IMAGE") throw new ContentError(400, "cover_url: muqova rasm bo'lishi kerak");

    // The downloaded kinds decide the type now (an extension-less URL may have been a video).
    const kinds = media.map((m) => m.kind);
    const real: CsvRow = { ...row, type: resolveType(row.requestedType, kinds) };
    const issues = rowIssues(real, kinds, ctx);
    if (!row.draft && issues.length) throw new ContentError(400, issues.join("; "));
    if (row.draft) base.warnings.push(...issues.map((m) => `Rejalashtirishdan oldin tuzating: ${m}`));

    const input = rowToPostInput(real, media.map((m) => m.mediaId), cover?.mediaId ?? null);
    const post = await createPost(workspaceId, userId, { ...input, labels: ["csv-import"] });
    if (row.scheduledAt) await prisma.scheduledPost.update({ where: { id: post.id }, data: { scheduledAt: new Date(row.scheduledAt) } });
    if (row.campaign) {
      try {
        await attachCampaignToPost(workspaceId, post.id, row.campaign.kind === "automation" ? { automationId: row.campaign.id } : { triggerCampaignId: row.campaign.id });
      } catch (error) {
        base.warnings.push(`Kampaniya ulanmadi: ${error instanceof ContentError ? error.message : "kutilmagan xato"}`);
      }
    }
    return { ...base, ok: true, postId: post.id };
  } catch (error) {
    await releaseMedia(workspaceId, fetched);
    const message = error instanceof ContentError ? error.message : "Kutilmagan xato";
    if (!(error instanceof ContentError)) console.error("[Content] csv row failed:", error instanceof Error ? error.message : error);
    return { ...base, ok: false, error: message, wantsSchedule: false };
  }
}

export async function commitCsvImport(workspaceId: string, userId: string | null, csv: string, rowNumbers: number[], deps: MediaImportDeps & { now?: Date } = {}): Promise<CommitResult> {
  const now = deps.now ?? new Date();
  const ctx = await loadContext(workspaceId, now);
  let preview: CsvPreview;
  try {
    preview = normalizeCsv(csv, ctx);
  } catch (error) {
    if (error instanceof CsvError) throw new ContentError(400, error.message);
    throw error;
  }
  if (preview.fileErrors.length) throw new ContentError(400, preview.fileErrors.join("; "));
  const wanted = [...new Set(rowNumbers)];
  if (wanted.length === 0) throw new ContentError(400, "Import uchun birorta qator tanlanmagan");
  const byRow = new Map(preview.rows.map((r) => [r.row, r]));
  const missing = wanted.filter((n) => !byRow.has(n));
  if (missing.length) throw new ContentError(400, `Faylda bunday qator yo'q: ${missing.slice(0, 10).join(", ")}`);
  const selected = wanted.map((n) => byRow.get(n)!).sort((a, b) => a.row - b.row);
  const bad = selected.filter((r) => r.errors.length > 0);
  if (bad.length) {
    throw new ContentError(400, `Xatoli qatorlar import qilinmaydi: ${bad.map((r) => r.row).slice(0, 20).join(", ")} — faylni tuzating yoki ularni tanlovdan olib tashlang`);
  }
  const files = selected.reduce((n, r) => n + r.media.length + (r.coverUrl ? 1 : 0), 0);
  if (files > COMMIT_MAX_FILES) throw new ContentError(400, `Bir martada ko'pi bilan ${COMMIT_MAX_FILES} ta fayl yuklanadi (${files} ta tanlangan) — kamroq qator tanlang`);

  const results: CommitRowResult[] = [];
  for (const row of selected) results.push(await commitRow(workspaceId, userId, row, ctx, deps));

  const created = results.filter((r) => r.ok).length;
  try {
    await prisma.operationalEvent.create({
      data: { workspaceId, source: "SYSTEM", level: "INFO", message: `Kontent: CSV import — ${created} ta post yaratildi, ${results.length - created} ta qator xato`, payload: { rows: results.map((r) => ({ row: r.row, ok: r.ok, postId: r.postId ?? null })) } },
    });
  } catch (error) {
    console.error("[Content] csv audit failed:", error instanceof Error ? error.message : error);
  }
  return { results, created, failed: results.length - created, toSchedule: results.filter((r) => r.ok && r.wantsSchedule).map((r) => r.postId!) };
}

export interface ScheduleImportedResult {
  scheduled: Array<{ postId: string; scheduledAt: string | null }>;
  /** Media still processing: call again in a few seconds. */
  pending: string[];
  failed: Array<{ postId: string; error: string }>;
}

/** Schedules imported drafts at their planned time once all their media are READY. */
export async function scheduleImportedPosts(workspaceId: string, postIds: string[], now: Date = new Date()): Promise<ScheduleImportedResult> {
  const out: ScheduleImportedResult = { scheduled: [], pending: [], failed: [] };
  for (const postId of [...new Set(postIds)].slice(0, 200)) {
    try {
      const post = await getPost(workspaceId, postId);
      if (post.status === "SCHEDULED") {
        out.scheduled.push({ postId, scheduledAt: post.scheduledAt?.toISOString() ?? null });
        continue;
      }
      if (post.status !== "DRAFT") throw new ContentError(409, "Post draft emas");
      if (!post.scheduledAt) throw new ContentError(400, "Postda rejalashtirilgan vaqt yo'q");
      const cover = post.coverMediaId ? await prisma.mediaAsset.findUnique({ where: { id: post.coverMediaId }, select: { status: true } }) : null;
      const statuses = [...post.media.map((m) => m.status), ...(cover ? [cover.status] : [])];
      if (statuses.some((s) => s === "FAILED" || s === "DELETED")) throw new ContentError(400, "Media qayta ishlanmadi — postni ochib boshqa fayl tanlang");
      if (statuses.some((s) => s !== "READY")) {
        out.pending.push(postId);
        continue;
      }
      const done = await schedulePost(workspaceId, postId, post.scheduledAt, { now });
      out.scheduled.push({ postId, scheduledAt: done.scheduledAt?.toISOString() ?? null });
    } catch (error) {
      out.failed.push({ postId, error: error instanceof ContentError ? error.message : "Kutilmagan xato" });
    }
  }
  return out;
}
