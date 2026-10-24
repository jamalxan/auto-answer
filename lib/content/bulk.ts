/**
 * ETAP 13 Faza 2 (WP-D) — calendar moves and bulk actions (FR-S6, FR-V4).
 *
 * movePost is what a drag-and-drop (or the "Ko'chirish" fallback) does:
 *   SCHEDULED → schedulePost at the new time (every rule: 5-minute lead,
 *               FR-S4 spacing, 24-hour quota; jobs re-armed). Needs the
 *               schedule permission.
 *   DRAFT     → only the planned time moves; the post stays a DRAFT even
 *               when it is complete — a drag never schedules (ruling: moving
 *               a card must not change what it is; "Rejalashtirish" does).
 *               Lead rule applies so a plan never lands in the past.
 *   PAUSED    → (bulk shift only) the stored time moves, the post stays
 *               paused; resume re-checks everything. Needs schedule.
 * Anything else (in flight, published, in review) is refused with 409.
 *
 * runBulk applies one action to up to BULK_MAX posts and reports every id:
 * a failure of one never aborts the rest and never goes unreported. Foreign
 * or unknown ids come back as "Post topilmadi" (tenant isolation).
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { canContent } from "./permissions";
import { submitForReview, reviewSubmitSchema } from "./review";
import { ContentError } from "./errors";
import { deletePost, getPost, loadRow, pausePost, schedulePost, type PostDetail } from "./service";
import type { PostStatusValue } from "./schema";
import { utcToZoned, zonedToUtc } from "./time";
import { scheduleIssues } from "./validate";

export const BULK_MAX = 100;

const ids = z
  .array(z.string().min(1))
  .min(1, "Kamida bitta post tanlang")
  .max(BULK_MAX, `Bir martada ko'pi bilan ${BULK_MAX} ta post`);

export const SHIFT_UNITS = ["minutes", "hours", "days"] as const;
export type ShiftUnit = (typeof SHIFT_UNITS)[number];

export const bulkInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("shift"),
    ids,
    amount: z.number().int().refine((n) => n !== 0, "Surish miqdori 0 bo'lmasin").refine((n) => Math.abs(n) <= 100_000, "Surish miqdori juda katta"),
    unit: z.enum(SHIFT_UNITS),
  }),
  z.object({ action: z.literal("pause"), ids }),
  z.object({ action: z.literal("delete"), ids }),
  z.object({
    action: z.literal("review"),
    ids,
    reviewerUserIds: reviewSubmitSchema.shape.reviewerUserIds,
    externalEmails: reviewSubmitSchema.shape.externalEmails,
    rule: reviewSubmitSchema.shape.rule,
  }),
]);
export type BulkInput = z.infer<typeof bulkInputSchema>;
export type BulkAction = BulkInput["action"];

/**
 * Route-level permission of each bulk action — the same as the single
 * action: pause / delete are MANAGER+, sending to review is OPERATOR+, a
 * shift is OPERATOR+ at the door and MANAGER+ per SCHEDULED / PAUSED item
 * (like a drag: a draft's plan is an edit, a queued slot is scheduling).
 */
export const BULK_ACCESS = { shift: "create", pause: "schedule", delete: "schedule", review: "create" } as const satisfies Record<BulkAction, "create" | "schedule">;

export interface BulkItemResult {
  id: string;
  ok: boolean;
  status?: PostStatusValue;
  scheduledAt?: Date | null;
  error?: string;
}

export interface BulkReport {
  action: BulkAction;
  done: number;
  failed: number;
  results: BulkItemResult[];
}

export interface MoveOptions {
  /** Whether the caller holds content.schedule (SCHEDULED / PAUSED moves need it). */
  canSchedule: boolean;
  now?: Date;
  /** PAUSED moves are a bulk-shift thing; a drag only takes SCHEDULED and DRAFT. */
  allowPaused?: boolean;
}

const NO_SCHEDULE = "Ruxsat yo'q: Postni rejalashtirish va chiqarish";

export async function movePost(workspaceId: string, postId: string, at: Date, opts: MoveOptions): Promise<PostDetail> {
  const now = opts.now ?? new Date();
  const row = await loadRow(workspaceId, postId);
  if (row.status === "SCHEDULED") {
    if (!opts.canSchedule) throw new ContentError(403, NO_SCHEDULE);
    return schedulePost(workspaceId, postId, at, { now });
  }
  const planOnly = row.status === "DRAFT" || (opts.allowPaused && row.status === "PAUSED");
  if (!planOnly) throw new ContentError(409, "Faqat rejalashtirilgan yoki draft postni ko'chirish mumkin");
  if (row.status === "PAUSED" && !opts.canSchedule) throw new ContentError(403, NO_SCHEDULE);
  const when = scheduleIssues(at, now);
  if (when.length) throw new ContentError(400, when[0].message);
  const r = await prisma.scheduledPost.updateMany({
    where: { id: postId, status: row.status, version: row.version },
    data: { scheduledAt: at, version: { increment: 1 } },
  });
  if (r.count === 0) throw new ContentError(409, "Post boshqa joyda o'zgartirilgan — sahifani yangilang");
  return getPost(workspaceId, postId);
}

/** Minutes and hours are exact; days keep the wall-clock time in the zone. */
export function shiftInstant(at: Date, amount: number, unit: ShiftUnit, timezone: string): Date {
  if (unit === "minutes") return new Date(at.getTime() + amount * 60_000);
  if (unit === "hours") return new Date(at.getTime() + amount * 3_600_000);
  const { date, time } = utcToZoned(at, timezone);
  const day = new Date(`${date}T00:00:00Z`);
  const next = new Date(day.getTime() + amount * 86_400_000).toISOString().slice(0, 10);
  return zonedToUtc(next, time, timezone);
}

function errorText(error: unknown): string {
  if (error instanceof ContentError) return error.message;
  console.error("[Content] bulk item failed:", error instanceof Error ? error.message : error);
  return "Kutilmagan xato — birozdan keyin qayta urinib ko'ring";
}

export async function runBulk(workspaceId: string, userId: string, role: string, input: BulkInput, opts: { now?: Date } = {}): Promise<BulkReport> {
  const now = opts.now ?? new Date();
  const canSchedule = canContent(role, "content.schedule");
  let order = [...new Set(input.ids)];

  // A shift moves several posts of one account at once: move the far end first
  // so FR-S4 spacing does not push a post into the slot its neighbour is leaving.
  const known = await prisma.scheduledPost.findMany({
    where: { id: { in: order }, workspaceId, deletedAt: null },
    select: { id: true, scheduledAt: true, timezone: true },
  });
  const byId = new Map(known.map((k) => [k.id, k]));
  if (input.action === "shift") {
    const sign = input.amount > 0 ? -1 : 1;
    order = [...order].sort((a, b) => {
      const ta = byId.get(a)?.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const tb = byId.get(b)?.scheduledAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (ta === tb) return 0;
      if (!Number.isFinite(ta)) return 1;
      if (!Number.isFinite(tb)) return -1;
      return sign * (ta - tb);
    });
  }

  const results: BulkItemResult[] = [];
  for (const id of order) {
    try {
      let post: PostDetail | null = null;
      switch (input.action) {
        case "shift": {
          const row = byId.get(id);
          if (!row) throw new ContentError(404, "Post topilmadi");
          if (!row.scheduledAt) throw new ContentError(400, "Postda vaqt yo'q — surib bo'lmaydi");
          const at = shiftInstant(row.scheduledAt, input.amount, input.unit, row.timezone);
          post = await movePost(workspaceId, id, at, { canSchedule, now, allowPaused: true });
          break;
        }
        case "pause":
          post = await pausePost(workspaceId, id);
          break;
        case "delete":
          await deletePost(workspaceId, id);
          break;
        case "review": {
          const row = await loadRow(workspaceId, id);
          if (!row.scheduledAt) throw new ContentError(400, "Postda rejalashtirilgan vaqt yo'q — avval vaqt qo'ying");
          post = await submitForReview(workspaceId, id, userId, { reviewerUserIds: input.reviewerUserIds, externalEmails: input.externalEmails, rule: input.rule, scheduledAt: row.scheduledAt }, { now });
          break;
        }
      }
      results.push({ id, ok: true, ...(post ? { status: post.status, scheduledAt: post.scheduledAt } : {}) });
    } catch (error) {
      results.push({ id, ok: false, error: errorText(error) });
    }
  }
  const done = results.filter((r) => r.ok).length;
  return { action: input.action, done, failed: results.length - done, results };
}
