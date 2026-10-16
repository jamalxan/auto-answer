/**
 * The single LLM outcome reader. Every model call writes ONE `llm_usage` row
 * (success flag, latency, model, tokens, cost); Diagnostics, Analytics (AI),
 * the KPI strip and JavobAI "Xarajat" all derive their error counts and
 * latency from these rows, so the numbers cannot disagree (live test B-29).
 */

import { prisma } from "@/lib/db/client";

/** From this error rate (share of failed calls) the AI is flagged "Diqqat". */
export const LLM_ERROR_WARN_RATE = 0.05;
/** Fewer calls than this are too few to judge a rate. */
export const LLM_MIN_CALLS_FOR_RATE = 5;

export interface LlmStats {
  calls: number;
  failures: number;
  /** failures / calls, null without calls. */
  errorRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function summarizeLlmRows(rows: Array<{ ok: boolean; latencyMs: unknown }>): LlmStats {
  const calls = rows.length;
  const failures = rows.filter((r) => !r.ok).length;
  const latencies = rows.map((r) => Number(r.latencyMs) || 0).filter((n) => n > 0);
  return {
    calls,
    failures,
    errorRate: calls ? Math.round((failures / calls) * 10_000) / 10_000 : null,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length) : null,
    p95LatencyMs: percentile(latencies, 95),
  };
}

/** True when the failure share is at or above the warning rate (with enough calls). */
export function isLlmErrorRateHigh(stats: Pick<LlmStats, "calls" | "failures">): boolean {
  return stats.calls >= LLM_MIN_CALLS_FOR_RATE && stats.failures / stats.calls >= LLM_ERROR_WARN_RATE;
}

export async function loadLlmStats(workspaceId: string, since: Date, until?: Date): Promise<LlmStats> {
  const rows = (await prisma.llmUsage.findMany({
    where: { workspaceId, createdAt: until ? { gte: since, lt: until } : { gte: since } },
    select: { ok: true, latencyMs: true },
  })) as unknown as Array<{ ok: boolean; latencyMs: number }>;
  return summarizeLlmRows(rows);
}
