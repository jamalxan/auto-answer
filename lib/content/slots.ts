/**
 * ETAP 13 Faza 2 — FR-S9 posting slots: a weekly set of times per Instagram
 * account ("Du 09:00, Ch 19:00 · faqat Reels"), and "Navbatga qo'shish" —
 * schedule a post into the next free slot at least five minutes from now.
 *
 * weekday 0 = Monday; minuteOfDay 0…1439 is wall-clock in the workspace
 * zone. A slot is taken when a queued post of the account sits in the same
 * minute. A slot with a postType only takes that type; one without takes any.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { CONTENT_LIMITS } from "./config";
import { ContentError, notFound } from "./errors";
import { POST_TYPES, type PostTypeValue } from "./schema";
import { getPost, schedulePost, type PostDetail } from "./service";
import { DEFAULT_TIMEZONE, utcToZoned, zonedToUtc } from "./time";
import { QUEUED } from "./transitions";

export const SLOTS_MAX = 100;
/** How far ahead "next free slot" looks. */
export const SLOT_HORIZON_DAYS = 8 * 7;

export const slotInputSchema = z.object({
  weekday: z.number().int().min(0, "hafta kuni 0…6").max(6, "hafta kuni 0…6"),
  minuteOfDay: z.number().int().min(0, "vaqt 00:00…23:59").max(1439, "vaqt 00:00…23:59"),
  postType: z.enum(POST_TYPES).nullable().optional(),
});
export const slotsInputSchema = z.object({ slots: z.array(slotInputSchema).max(SLOTS_MAX, `Ko'pi bilan ${SLOTS_MAX} ta slot`) });
export type SlotInput = z.infer<typeof slotInputSchema>;

export interface SlotView {
  id: string;
  weekday: number;
  minuteOfDay: number;
  postType: PostTypeValue | null;
}

async function ownedAccount(workspaceId: string, accountId: string) {
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId }, select: { id: true, workspaceId: true } });
  if (!account || account.workspaceId !== workspaceId) throw notFound("Instagram akkaunt topilmadi");
  return account;
}

async function workspaceZone(workspaceId: string): Promise<string> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
  return ws?.timezone || DEFAULT_TIMEZONE;
}

async function readSlots(accountId: string): Promise<SlotView[]> {
  const rows = await prisma.postingSlot.findMany({ where: { instagramAccountId: accountId }, orderBy: [{ weekday: "asc" }, { minuteOfDay: "asc" }] });
  return rows.map((r) => ({ id: r.id, weekday: r.weekday, minuteOfDay: r.minuteOfDay, postType: (r.postType as PostTypeValue | null) ?? null }));
}

export async function listSlots(workspaceId: string, accountId: string): Promise<{ slots: SlotView[]; timezone: string }> {
  await ownedAccount(workspaceId, accountId);
  return { slots: await readSlots(accountId), timezone: await workspaceZone(workspaceId) };
}

/** PUT replaces the whole weekly set; a repeated weekday + minute keeps the last one. */
export async function replaceSlots(workspaceId: string, accountId: string, slots: SlotInput[]): Promise<{ slots: SlotView[]; timezone: string }> {
  await ownedAccount(workspaceId, accountId);
  const unique = new Map<string, SlotInput>();
  for (const s of slots) unique.set(`${s.weekday}:${s.minuteOfDay}`, s);
  await prisma.$transaction([
    prisma.postingSlot.deleteMany({ where: { instagramAccountId: accountId } }),
    prisma.postingSlot.createMany({
      data: [...unique.values()].map((s) => ({ instagramAccountId: accountId, weekday: s.weekday, minuteOfDay: s.minuteOfDay, postType: s.postType ?? null })),
    }),
  ]);
  return listSlots(workspaceId, accountId);
}

const pad = (n: number) => String(n).padStart(2, "0");
export const minuteLabel = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const DAY_MS = 86_400_000;

/** Slot instants (sorted) from `after` on, over the horizon — pure. */
export function slotInstants(slots: Array<Pick<SlotView, "weekday" | "minuteOfDay" | "postType">>, after: Date, timezone: string, opts: { postType?: PostTypeValue; days?: number } = {}): Date[] {
  const fitting = slots.filter((s) => !opts.postType || !s.postType || s.postType === opts.postType);
  if (fitting.length === 0) return [];
  const startDay = Date.parse(`${utcToZoned(after, timezone).date}T00:00:00Z`) / DAY_MS;
  const out: Date[] = [];
  for (let n = startDay; n <= startDay + (opts.days ?? SLOT_HORIZON_DAYS); n++) {
    const date = new Date(n * DAY_MS).toISOString().slice(0, 10);
    const weekday = (new Date(n * DAY_MS).getUTCDay() + 6) % 7;
    for (const s of fitting) {
      if (s.weekday !== weekday) continue;
      const at = zonedToUtc(date, minuteLabel(s.minuteOfDay), timezone);
      if (at.getTime() >= after.getTime()) out.push(at);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** The first slot at or after `after` that no queued post of the account occupies. */
export async function nextFreeSlot(accountId: string, after: Date, opts: { postType?: PostTypeValue; timezone?: string; excludePostId?: string } = {}): Promise<Date | null> {
  const slots = await readSlots(accountId);
  const timezone = opts.timezone ?? DEFAULT_TIMEZONE;
  const candidates = slotInstants(slots, after, timezone, { postType: opts.postType });
  if (candidates.length === 0) return null;
  const last = candidates[candidates.length - 1];
  const taken = await prisma.scheduledPost.findMany({
    where: {
      instagramAccountId: accountId,
      deletedAt: null,
      status: { in: QUEUED },
      ...(opts.excludePostId ? { id: { not: opts.excludePostId } } : {}),
      scheduledAt: { gte: new Date(after.getTime() - 60_000), lte: new Date(last.getTime() + 60_000) },
    },
    select: { scheduledAt: true },
  });
  const busy = taken.map((t) => t.scheduledAt?.getTime()).filter((t): t is number => typeof t === "number");
  return candidates.find((c) => !busy.some((b) => Math.abs(b - c.getTime()) < 60_000)) ?? null;
}

/** "Navbatga qo'shish": the next free slot ≥ now + 5 min, then the usual scheduling rules. */
export async function queuePost(workspaceId: string, postId: string, opts: { now?: Date } = {}): Promise<PostDetail> {
  const now = opts.now ?? new Date();
  const post = await getPost(workspaceId, postId);
  const timezone = await workspaceZone(workspaceId);
  const slot = await nextFreeSlot(post.instagramAccountId, new Date(now.getTime() + CONTENT_LIMITS.minScheduleLeadMs), { postType: post.type, timezone, excludePostId: post.id });
  if (!slot) throw new ContentError(409, "Bo'sh slot topilmadi — kalendardagi «Slotlar» da vaqt qo'shing");
  return schedulePost(workspaceId, postId, slot, { now });
}
