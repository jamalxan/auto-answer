/**
 * ETAP 13 Faza 2 — FR-S8 recurring posts: the pure expansion of a rule into
 * the UTC instants of every copy. The time is a wall-clock time in the
 * post's zone (Asia/Tashkent by default), so "every day at 19:00" stays
 * 19:00 across a DST change elsewhere. Calendar arithmetic runs on plain
 * dates (Date.UTC), the zone is applied per date through time.ts.
 *
 * Client-safe: the composer shows the live copy count with the same code
 * the server schedules with. Nothing is thrown — a result says why not.
 */

import { z } from "zod";
import { isValidTimeZone, zonedToUtc } from "./time";

export const RECURRENCE_LIMITS = {
  /** The end date may be at most this many days after the start date. */
  maxSpanDays: 180,
  /** Copies including the original post. */
  maxCopies: 200,
  maxInterval: 12,
} as const;

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  /** Every N days / weeks / months (default 1). */
  interval?: number;
  /** weekly: 0 = Monday … 6 = Sunday. */
  weekdays?: number[];
  /** YYYY-MM-DD, the first possible date (wall-clock, in `timezone`). */
  startDate: string;
  /** HH:mm wall-clock. */
  time: string;
  /** YYYY-MM-DD, inclusive. */
  until: string;
  timezone: string;
}

export type RecurrenceResult = { ok: true; dates: Date[] } | { ok: false; error: string };

/** The `recur` action body; the zone comes from the post. */
export const recurInputSchema = z.object({
  frequency: z.enum(RECURRENCE_FREQUENCIES),
  interval: z.number().int().min(1).max(RECURRENCE_LIMITS.maxInterval).optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "sana YYYY-MM-DD bo'lsin"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "vaqt HH:mm bo'lsin"),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "tugash sanasi YYYY-MM-DD bo'lsin"),
});
export type RecurInput = z.infer<typeof recurInputSchema>;

const DAY_MS = 86_400_000;

/** "2026-10-24" → days since the epoch, or null when it is not a real date. */
function dayNumber(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

const isoOfDay = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** 0 = Monday. */
const weekdayOfDay = (n: number) => (new Date(n * DAY_MS).getUTCDay() + 6) % 7;
const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** Every calendar date of the rule, without the limits. */
function ruleDates(rule: RecurrenceRule, start: number, end: number, cap: number): string[] {
  const interval = Math.max(1, Math.floor(rule.interval ?? 1));
  const out: string[] = [];
  if (rule.frequency === "daily") {
    for (let n = start; n <= end && out.length <= cap; n += interval) out.push(isoOfDay(n));
  } else if (rule.frequency === "weekly") {
    const days = new Set(rule.weekdays ?? []);
    const firstMonday = start - weekdayOfDay(start);
    for (let n = start; n <= end && out.length <= cap; n++) {
      const week = Math.floor((n - firstMonday) / 7);
      if (week % interval === 0 && days.has(weekdayOfDay(n))) out.push(isoOfDay(n));
    }
  } else {
    const first = new Date(start * DAY_MS);
    const [y, m0, d] = [first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()];
    for (let k = 0; out.length <= cap; k += interval) {
      const yy = y + Math.floor((m0 + k) / 12);
      const mm = (m0 + k) % 12;
      const n = Date.UTC(yy, mm, 1) / DAY_MS;
      if (n > end) break;
      if (d > daysInMonth(yy, mm)) continue;
      const day = n + d - 1;
      if (day <= end) out.push(isoOfDay(day));
    }
  }
  return out;
}

export function expandRecurrence(rule: RecurrenceRule, limits: { maxSpanDays?: number; maxCopies?: number } = {}): RecurrenceResult {
  const maxSpan = limits.maxSpanDays ?? RECURRENCE_LIMITS.maxSpanDays;
  const maxCopies = limits.maxCopies ?? RECURRENCE_LIMITS.maxCopies;
  const start = dayNumber(rule.startDate);
  const end = dayNumber(rule.until);
  if (start === null) return { ok: false, error: "Boshlanish sanasi noto'g'ri" };
  if (end === null) return { ok: false, error: "Tugash sanasi noto'g'ri" };
  const t = /^(\d{2}):(\d{2})$/.exec(rule.time);
  if (!t || Number(t[1]) > 23 || Number(t[2]) > 59) return { ok: false, error: "Vaqt noto'g'ri" };
  if (!isValidTimeZone(rule.timezone)) return { ok: false, error: "Vaqt zonasi noto'g'ri" };
  if (end < start) return { ok: false, error: "Tugash sanasi boshlanishdan oldin bo'lmasin" };
  if (end - start > maxSpan) return { ok: false, error: `Takrorlash ko'pi bilan ${maxSpan} kunga — tugash sanasini yaqinroq tanlang` };
  if (rule.frequency === "weekly" && !(rule.weekdays ?? []).length) return { ok: false, error: "Hafta kunlarini tanlang" };

  const dates = ruleDates(rule, start, end, maxCopies);
  if (dates.length === 0) return { ok: false, error: "Tanlangan oraliqda birorta sana yo'q" };
  if (dates.length > maxCopies) return { ok: false, error: `Ko'pi bilan ${maxCopies} ta nusxa — oraliqni qisqartiring yoki kamroq kun tanlang` };
  return { ok: true, dates: dates.map((date) => zonedToUtc(date, rule.time, rule.timezone)) };
}
