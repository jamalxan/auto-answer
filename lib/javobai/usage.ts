/**
 * JavobAI usage accounting (ETAP 4.4, TZ §66 "per-tenant AI usage").
 *
 * Every JavobAI LLM / STT / vision call writes one `LlmUsage` row — the same
 * table and shape production uses (lib/assistant/engine.ts), distinguished by
 * `kind` ("javobai_*"). The aggregations here are per workspace and per
 * calendar month in Asia/Tashkent (UTC+5, no DST), the same convention as the
 * reports (lib/reports/data.ts): a customer's "October" is October in Tashkent.
 *
 * Aggregation is done in memory from a bounded `findMany` (one workspace, one
 * month) rather than `groupBy` so it works against the in-memory test db and
 * stays independent of Prisma's aggregate typing.
 */

import { prisma } from "@/lib/db/client";

export const JAVOBAI_USAGE_KINDS = [
  "javobai_reply",
  "javobai_shadow",
  "javobai_summary",
  "javobai_stt",
  "javobai_vision",
  "javobai_sandbox",
  "javobai_flowbuilder",
] as const;
export type JavobAiUsageKind = (typeof JAVOBAI_USAGE_KINDS)[number];

export const JAVOBAI_USAGE_KIND_LABELS: Record<JavobAiUsageKind, string> = {
  javobai_reply: "Javoblar (LIVE)",
  javobai_shadow: "Shadow javoblar",
  javobai_summary: "Suhbat xulosasi",
  javobai_stt: "Ovozli xabarlar (STT)",
  javobai_vision: "Rasmlar (vision)",
  javobai_sandbox: "Sandbox",
  javobai_flowbuilder: "Flow Builder (AI)",
};

export function isJavobAiKind(kind: string): boolean {
  return kind.startsWith("javobai_");
}

export interface RecordJavobAiUsageInput {
  workspaceId: string;
  conversationId?: string | null;
  kind: JavobAiUsageKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
}

/**
 * Write one usage row. Never throws: a failed bookkeeping write must not fail
 * the customer's turn (production does the same). Returns whether it was stored.
 */
export async function recordJavobAiUsage(input: RecordJavobAiUsageInput): Promise<boolean> {
  try {
    await prisma.llmUsage.create({
      data: {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId ?? null,
        kind: input.kind,
        model: input.model,
        inputTokens: Math.max(0, Math.round(input.inputTokens) || 0),
        outputTokens: Math.max(0, Math.round(input.outputTokens) || 0),
        costUsd: roundUsd(input.costUsd),
        latencyMs: Math.max(0, Math.round(input.latencyMs) || 0),
        ok: input.ok,
      },
    });
    return true;
  } catch (error) {
    console.error("[JavobAI] usage write failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

// ─── Tashkent calendar ────────────────────────────────────────────────────────

export const TASHKENT_OFFSET_MIN = 300;
const OFFSET_MS = TASHKENT_OFFSET_MIN * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC instant of 00:00 on the 1st of the Tashkent month that contains `now`. */
export function tashkentMonthStart(now: Date = new Date()): Date {
  const local = new Date(now.getTime() + OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - OFFSET_MS);
}

/** UTC instant of 00:00 on the 1st of the Tashkent month after the one containing `now`. */
export function tashkentNextMonthStart(now: Date = new Date()): Date {
  const local = new Date(now.getTime() + OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - OFFSET_MS);
}

/** UTC instant of Tashkent midnight `daysAgo` days before the Tashkent day containing `now`. */
export function tashkentDayStart(now: Date = new Date(), daysAgo = 0): Date {
  const local = new Date(now.getTime() + OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo) - OFFSET_MS
  );
}

/** "YYYY-MM-DD" of the Tashkent day that contains `at`. */
export function tashkentDayKey(at: Date): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

// ─── Aggregations ─────────────────────────────────────────────────────────────

export interface UsageByKind {
  kind: string;
  /** True for JavobAI rows ("javobai_*"), false for the production assistant. */
  javobAi: boolean;
  label: string;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface MonthlyUsage {
  /** Start of the Tashkent calendar month (UTC instant). */
  periodStart: Date;
  /** Start of the next Tashkent month (exclusive end). */
  periodEnd: Date;
  byKind: UsageByKind[];
  totalUsd: number;
  javobAiUsd: number;
  productionUsd: number;
  calls: number;
}

type UsageRow = {
  kind: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: unknown;
  ok: boolean;
  createdAt: Date;
};

async function loadRows(workspaceId: string, from: Date, to: Date): Promise<UsageRow[]> {
  const rows = await prisma.llmUsage.findMany({
    where: { workspaceId, createdAt: { gte: from, lt: to } },
    select: { kind: true, inputTokens: true, outputTokens: true, costUsd: true, ok: true, createdAt: true },
  });
  return rows as UsageRow[];
}

/** Calendar-month (Asia/Tashkent) usage of one workspace, by kind. */
export async function monthlyUsage(workspaceId: string, now: Date = new Date()): Promise<MonthlyUsage> {
  const periodStart = tashkentMonthStart(now);
  const periodEnd = tashkentNextMonthStart(now);
  const rows = await loadRows(workspaceId, periodStart, periodEnd);

  const groups = new Map<string, UsageByKind>();
  for (const row of rows) {
    const kind = row.kind || "reply";
    let group = groups.get(kind);
    if (!group) {
      group = {
        kind,
        javobAi: isJavobAiKind(kind),
        label: (JAVOBAI_USAGE_KIND_LABELS as Record<string, string>)[kind] ?? kind,
        calls: 0,
        failedCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      groups.set(kind, group);
    }
    group.calls += 1;
    if (!row.ok) group.failedCalls += 1;
    group.inputTokens += Number(row.inputTokens) || 0;
    group.outputTokens += Number(row.outputTokens) || 0;
    group.costUsd += toUsd(row.costUsd);
  }

  const byKind = [...groups.values()]
    .map((g) => ({ ...g, costUsd: roundUsd(g.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls || a.kind.localeCompare(b.kind));
  const javobAiUsd = roundUsd(byKind.filter((g) => g.javobAi).reduce((sum, g) => sum + g.costUsd, 0));
  const productionUsd = roundUsd(byKind.filter((g) => !g.javobAi).reduce((sum, g) => sum + g.costUsd, 0));

  return {
    periodStart,
    periodEnd,
    byKind,
    totalUsd: roundUsd(javobAiUsd + productionUsd),
    javobAiUsd,
    productionUsd,
    calls: rows.length,
  };
}

export interface DailyUsagePoint {
  /** Tashkent day, "YYYY-MM-DD". */
  day: string;
  calls: number;
  javobAiUsd: number;
  productionUsd: number;
  totalUsd: number;
}

/**
 * One point per Tashkent day for the last `days` days (today included, oldest
 * first, days without usage are zero-filled) — the "Xarajat" chart.
 */
export async function dailySeries(
  workspaceId: string,
  days = 30,
  now: Date = new Date()
): Promise<DailyUsagePoint[]> {
  const span = Math.min(366, Math.max(1, Math.floor(days) || 1));
  const from = tashkentDayStart(now, span - 1);
  const to = new Date(tashkentDayStart(now, 0).getTime() + DAY_MS);
  const rows = await loadRows(workspaceId, from, to);

  const points = new Map<string, DailyUsagePoint>();
  for (let i = span - 1; i >= 0; i--) {
    const day = tashkentDayKey(tashkentDayStart(now, i));
    points.set(day, { day, calls: 0, javobAiUsd: 0, productionUsd: 0, totalUsd: 0 });
  }
  for (const row of rows) {
    const point = points.get(tashkentDayKey(row.createdAt));
    if (!point) continue;
    point.calls += 1;
    const usd = toUsd(row.costUsd);
    if (isJavobAiKind(row.kind || "")) point.javobAiUsd += usd;
    else point.productionUsd += usd;
  }
  return [...points.values()].map((p) => ({
    ...p,
    javobAiUsd: roundUsd(p.javobAiUsd),
    productionUsd: roundUsd(p.productionUsd),
    totalUsd: roundUsd(p.javobAiUsd + p.productionUsd),
  }));
}

// ─── Numbers ──────────────────────────────────────────────────────────────────

/** Prisma Decimal | number | string → finite number (0 when unreadable). */
export function toUsd(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Six decimals, like the `LlmUsage.costUsd` column. */
export function roundUsd(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}
