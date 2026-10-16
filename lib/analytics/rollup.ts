/**
 * ETAP 10 - persists `computeDayMetrics` into AnalyticsDaily.
 *
 * A day is REPLACED, never appended: the rows of (workspace, day) are deleted
 * and the fresh ones inserted in one transaction, so recomputing is idempotent
 * and a metric that dropped to zero disappears instead of going stale.
 * Zero-valued rows are not stored; the read side zero-fills.
 */

import { prisma } from "@/lib/db/client";
import { computeDayMetrics } from "./compute";
import { addDays, dayColumn, dayCount, isDayKey, listDayKeys, MAX_RANGE_DAYS, todayKey } from "./time";

export interface RollupResult {
  day: string;
  rows: number;
}

/** Recompute one Tashkent day of one workspace and replace its stored rows. */
export async function rollupDay(workspaceId: string, dayKey: string, now: Date = new Date()): Promise<RollupResult> {
  const rows = await computeDayMetrics(workspaceId, dayKey);
  const day = dayColumn(dayKey);
  await prisma.$transaction([
    prisma.analyticsDaily.deleteMany({ where: { workspaceId, day } }),
    prisma.analyticsDaily.createMany({
      data: rows.map((row) => ({
        workspaceId,
        instagramAccountId: row.instagramAccountId,
        day,
        metric: row.metric,
        dimKind: row.dimKind,
        dimId: row.dimId,
        value: row.value,
        computedAt: now,
      })),
    }),
  ]);
  return { day: dayKey, rows: rows.length };
}

/** Recompute `from..to` (inclusive), oldest first. Bounded to a year. */
export async function rollupRange(workspaceId: string, from: string, to: string, now: Date = new Date()): Promise<RollupResult[]> {
  if (!isDayKey(from) || !isDayKey(to) || from > to) return [];
  const results: RollupResult[] = [];
  for (const key of listDayKeys(from, to).slice(0, MAX_RANGE_DAYS)) {
    results.push(await rollupDay(workspaceId, key, now));
  }
  return results;
}

/** Yesterday + today: what the 10-minute incremental run refreshes. */
export function incrementalDays(now: Date = new Date()): { from: string; to: string } {
  const today = todayKey(now);
  return { from: addDays(today, -1), to: today };
}

/** The nightly run: the last `days` days, today included (late sales and handoffs catch up). */
export function trailingDays(now: Date = new Date(), days = 3): { from: string; to: string } {
  const today = todayKey(now);
  return { from: addDays(today, -(Math.max(1, days) - 1)), to: today };
}

/** The trailing window for a backfill of `days` days, clamped to 1..366. */
export function backfillWindow(days: number, now: Date = new Date()): { from: string; to: string; days: number } {
  const span = Math.min(MAX_RANGE_DAYS, Math.max(1, Math.floor(days) || 1));
  const to = todayKey(now);
  const from = addDays(to, -(span - 1));
  return { from, to, days: dayCount(from, to) };
}

/** Workspaces worth rolling up: those with a connected Instagram account. */
export async function activeWorkspaceIds(): Promise<string[]> {
  const accounts = await prisma.instagramAccount.findMany({ select: { workspaceId: true } });
  return [...new Set((accounts as Array<{ workspaceId: string }>).map((a) => a.workspaceId))];
}

export interface RollupAllResult {
  workspaces: number;
  days: number;
  failed: number;
}

/** One pass over every active workspace; a failing workspace never stops the others. */
export async function rollupAll(range: { from: string; to: string }, now: Date = new Date()): Promise<RollupAllResult> {
  const ids = await activeWorkspaceIds();
  let failed = 0;
  for (const workspaceId of ids) {
    try {
      await rollupRange(workspaceId, range.from, range.to, now);
    } catch (error) {
      failed += 1;
      console.error(`[Analytics] rollup failed for ${workspaceId}:`, error instanceof Error ? error.message : error);
    }
  }
  return { workspaces: ids.length, days: dayCount(range.from, range.to), failed };
}
