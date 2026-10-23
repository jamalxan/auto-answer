/**
 * ETAP 13 Faza 2 — series actions on top of the post service: FR-S8
 * recurrence (one draft → copies sharing a seriesId, each scheduled through
 * schedulePost so lead time, spacing and quota apply per copy), deleting the
 * future copies of a series, and copying one item's texts to the series'
 * unscheduled copies ("butun seriyaga qo'llash").
 *
 * Story series (FR-C9) are split inside schedulePost itself (service.ts).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { ContentError, notFound } from "./errors";
import { expandRecurrence, type RecurInput } from "./recurrence";
import { deletePost, duplicatePost, getPost, schedulePost, updatePost, type PostDetail } from "./service";
import { scheduleIssues } from "./validate";

export interface RecurReport {
  seriesId: string;
  total: number;
  scheduled: Array<{ id: string; seriesIndex: number; scheduledAt: Date | null }>;
  failed: Array<{ id: string; seriesIndex: number; at: Date; error: string }>;
}

function messageOf(error: unknown): string {
  return error instanceof ContentError ? error.message : "Kutilmagan xato";
}

/**
 * FR-S8: an existing DRAFT becomes copy 0 of a recurrence; copies 1…n-1 are
 * duplicates sharing its seriesId. A copy that cannot be scheduled (quota,
 * spacing, a changed account) stays a DRAFT in the series and is reported —
 * the others still go ahead.
 */
export async function recurPost(workspaceId: string, postId: string, rule: RecurInput, opts: { now?: Date } = {}): Promise<RecurReport> {
  const now = opts.now ?? new Date();
  const post = await getPost(workspaceId, postId);
  if (post.status !== "DRAFT") throw new ContentError(409, "Faqat draft postni takrorlash mumkin");
  if (post.type === "STORY" && post.media.length > 1) throw new ContentError(400, "Story seriyasini takrorlab bo'lmaydi — bitta media qoldiring");
  if (post.issues.length) throw new ContentError(400, post.issues.map((i) => i.message).join("; "));

  const expanded = expandRecurrence({ ...rule, timezone: post.timezone });
  if (!expanded.ok) throw new ContentError(400, expanded.error);
  const dates = expanded.dates;
  const lead = scheduleIssues(dates[0], now);
  if (lead.length) throw new ContentError(400, `Birinchi nusxa: ${lead[0].message.charAt(0).toLowerCase()}${lead[0].message.slice(1)}`);

  const seriesId = randomUUID();
  await prisma.scheduledPost.update({ where: { id: post.id }, data: { seriesId, seriesIndex: 0, version: { increment: 1 } } });
  const ids = [post.id];
  for (let i = 1; i < dates.length; i++) {
    const copy = await duplicatePost(workspaceId, post.id, {});
    await prisma.scheduledPost.update({ where: { id: copy.id }, data: { seriesId, seriesIndex: i } });
    ids.push(copy.id);
  }

  const report: RecurReport = { seriesId, total: dates.length, scheduled: [], failed: [] };
  for (let i = 0; i < ids.length; i++) {
    try {
      const done = await schedulePost(workspaceId, ids[i], dates[i], { now });
      report.scheduled.push({ id: ids[i], seriesIndex: i, scheduledAt: done.scheduledAt });
    } catch (error) {
      if (!(error instanceof ContentError)) console.error("[Content] recur copy failed:", error instanceof Error ? error.message : error);
      report.failed.push({ id: ids[i], seriesIndex: i, at: dates[i], error: messageOf(error) });
    }
  }
  return report;
}

const UNTOUCHABLE = ["PUBLISHING", "PUBLISHED", "PUBLISHED_MANUAL"] as const;

async function seriesRow(workspaceId: string, postId: string) {
  const row = await prisma.scheduledPost.findUnique({ where: { id: postId }, select: { id: true, workspaceId: true, deletedAt: true, seriesId: true, seriesIndex: true } });
  if (!row || row.workspaceId !== workspaceId || row.deletedAt) throw notFound();
  if (!row.seriesId) throw new ContentError(400, "Post seriyaga kirmaydi");
  return row as typeof row & { seriesId: string };
}

/** "Keyingi nusxalarni o'chirish": every later item of the series not yet published or in flight. */
export async function deleteSeriesFuture(workspaceId: string, postId: string): Promise<{ deleted: number; skipped: number }> {
  const row = await seriesRow(workspaceId, postId);
  const later = await prisma.scheduledPost.findMany({
    where: { workspaceId, seriesId: row.seriesId, deletedAt: null, seriesIndex: { gt: row.seriesIndex ?? 0 } },
    select: { id: true, status: true },
  });
  let deleted = 0;
  let skipped = 0;
  for (const item of later) {
    if ((UNTOUCHABLE as readonly string[]).includes(item.status)) {
      skipped++;
      continue;
    }
    try {
      await deletePost(workspaceId, item.id);
      deleted++;
    } catch {
      skipped++;
    }
  }
  return { deleted, skipped };
}

/**
 * "Butun seriyaga qo'llash": this post's texts and switches go to every other
 * DRAFT item of the series (scheduled copies keep theirs — unschedule first).
 * Media stays per item: a story series differs exactly in its media.
 */
export async function applyToSeries(workspaceId: string, postId: string): Promise<{ updated: number; skipped: number; post: PostDetail }> {
  const row = await seriesRow(workspaceId, postId);
  const source = await getPost(workspaceId, postId);
  const others = await prisma.scheduledPost.findMany({
    where: { workspaceId, seriesId: row.seriesId, deletedAt: null, id: { not: row.id } },
    select: { id: true, status: true, version: true },
  });
  let updated = 0;
  let skipped = 0;
  for (const item of others) {
    if (item.status !== "DRAFT") {
      skipped++;
      continue;
    }
    try {
      await updatePost(workspaceId, item.id, {
        version: item.version,
        caption: source.caption ?? "",
        firstComment: source.firstComment ?? "",
        collaborators: source.collaborators,
        shareToFeed: source.shareToFeed,
        trialStrategy: source.trialStrategy as "MANUAL" | "SS_PERFORMANCE" | null,
        locationId: source.locationId,
        isAiGenerated: source.isAiGenerated,
        autoPublish: source.autoPublish,
        manualReason: source.manualReason as "STORY_STICKER" | "MUSIC" | "API_REJECTED" | "USER_CHOICE" | null,
        labels: source.labels,
      });
      updated++;
    } catch {
      skipped++;
    }
  }
  return { updated, skipped, post: source };
}
