/**
 * Day keys for the analytics rollups. The Tashkent calendar helpers live in
 * lib/javobai/usage.ts (one definition, shared with the reports); this file
 * re-exports them and adds the "YYYY-MM-DD" arithmetic the rollups need.
 * Pure.
 */

import { TASHKENT_OFFSET_MIN, tashkentDayKey, tashkentDayStart } from "@/lib/javobai/usage";

export { TASHKENT_OFFSET_MIN, tashkentDayKey, tashkentDayStart };

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 366;
const OFFSET_MS = TASHKENT_OFFSET_MIN * 60_000;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_KEY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Today's Tashkent day key. */
export function todayKey(now: Date = new Date()): string {
  return tashkentDayKey(now);
}

/** UTC instant of Tashkent midnight at the start of `key`. */
export function dayKeyStart(key: string): Date {
  return new Date(new Date(`${key}T00:00:00Z`).getTime() - OFFSET_MS);
}

/** The `[start, end)` UTC window of a Tashkent day. */
export function dayWindow(key: string): { start: Date; end: Date } {
  const start = dayKeyStart(key);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** The value stored in the `AnalyticsDaily.day` (@db.Date) column. */
export function dayColumn(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

export function columnToKey(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

export function addDays(key: string, days: number): string {
  return new Date(new Date(`${key}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive number of days between two keys (from <= to). */
export function dayCount(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / DAY_MS) + 1;
}

/** Every key from `from` to `to`, inclusive, oldest first. */
export function listDayKeys(from: string, to: string): string[] {
  const out: string[] = [];
  for (let key = from, i = 0; key <= to && i < MAX_RANGE_DAYS + 1; key = addDays(key, 1), i++) out.push(key);
  return out;
}

export type RangePreset = "today" | "7d" | "30d" | "custom";

export interface ResolvedRange {
  preset: RangePreset;
  from: string;
  to: string;
  days: number;
  /** The range includes today, so the last day is still filling up. */
  partial: boolean;
}

export type RangeResult = { ok: true; range: ResolvedRange } | { ok: false; error: string };

/**
 * today / 7d / 30d count back from today (inclusive); custom takes explicit
 * Tashkent day keys (at most a year, never in the future).
 */
export function resolveRange(
  input: { preset?: string | null; from?: string | null; to?: string | null },
  now: Date = new Date()
): RangeResult {
  const today = todayKey(now);
  const preset = input.preset === "today" || input.preset === "30d" || input.preset === "custom" ? input.preset : input.preset === "7d" ? "7d" : input.from || input.to ? "custom" : "7d";
  if (preset === "custom") {
    const from = input.from ?? input.to ?? today;
    const to = input.to ?? input.from ?? today;
    if (!isDayKey(from) || !isDayKey(to)) return { ok: false, error: "Sana YYYY-MM-DD ko'rinishida bo'lishi kerak" };
    if (from > to) return { ok: false, error: "Boshlanish sanasi tugash sanasidan keyin bo'lmasligi kerak" };
    const clampedTo = to > today ? today : to;
    if (from > clampedTo) return { ok: false, error: "Kelajak sanalari uchun ma'lumot yo'q" };
    const days = dayCount(from, clampedTo);
    if (days > MAX_RANGE_DAYS) return { ok: false, error: `Oraliq ${MAX_RANGE_DAYS} kundan oshmasligi kerak` };
    return { ok: true, range: { preset, from, to: clampedTo, days, partial: clampedTo === today } };
  }
  const days = preset === "today" ? 1 : preset === "30d" ? 30 : 7;
  return { ok: true, range: { preset, from: addDays(today, -(days - 1)), to: today, days, partial: true } };
}

/** The period of the same length that ends the day before `range` starts. */
export function previousRange(range: Pick<ResolvedRange, "from" | "days">): { from: string; to: string; days: number } {
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(range.days - 1)), to, days: range.days };
}
