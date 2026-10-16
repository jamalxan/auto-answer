/**
 * ETAP 10 - observability KPIs (TZ 65): the live health strip.
 *
 * Unlike the analytics tabs this reads live tables over short windows (minutes
 * to a day), because "messages per minute" or "webhook delay" are meaningless
 * as daily rollups. Every loader is isolated like `settle` in
 * lib/foundation/diagnostics.ts: one broken source (Redis down, a slow query)
 * turns into `null` + an entry in `failed`, never a failed page.
 *
 * The queue depths are PLATFORM-wide (BullMQ queues are shared by every
 * workspace) and labelled so; the per-workspace DM queue comes from
 * loadQueueStats.
 */

import type { JobType } from "bullmq";
import { prisma } from "@/lib/db/client";
import { loadConnections } from "@/lib/foundation/connections";
import { loadQueueStats, type QueueStats } from "@/lib/foundation/queue-stats";
import { withTimeout } from "@/lib/foundation/time";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { dayColumn, todayKey } from "./time";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export interface QueueDepth {
  queue: string;
  label: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface KpiData {
  generatedAt: string;
  connections: { total: number; healthy: number; broken: number } | null;
  activeCampaigns: { automations: number; triggers: number; total: number } | null;
  messagesPerMin: { perMin: number; last10min: number; sparkline: number[] } | null;
  queue: { dm: QueueStats["dm"]; triggerBacklog: number } | null;
  /** Platform-wide, not this workspace. */
  queueDepths: QueueDepth[] | null;
  errors: { last1h: number; last24h: number } | null;
  metaErrorRate: RateSample | null;
  aiLatencyMs: { avg: number | null; calls: number } | null;
  aiCostTodayUsd: number | null;
  messageSuccessRate: RateSample | null;
  webhookDelay: { avgMs: number | null; maxMs: number | null; samples: number } | null;
  today: { aiConversations: number; leads: number; hot: number; conversions: number } | null;
  worker: { healthy: boolean; ageMs: number | null } | null;
  /** Keys whose loader threw (the screen shows "yuklab bo'lmadi" for them). */
  failed: string[];
}

export interface RateSample {
  /** failures / attempts for the error rates, successes / attempts for the success rate; null without attempts. */
  rate: number | null;
  attempts: number;
  failures: number;
}

export function rateSample(failures: number, attempts: number, as: "failure" | "success" = "failure"): RateSample {
  const rate = attempts > 0 ? (as === "failure" ? failures : attempts - failures) / attempts : null;
  return { rate: rate === null ? null : Math.round(rate * 10_000) / 10_000, attempts, failures };
}

// ─── Shared signal loaders (also used by alerts.ts) ──────────────────────────

/** Meta send results since `since`: DM log + trigger executions. */
export async function loadMetaSendRate(workspaceId: string, since: Date): Promise<RateSample> {
  const [dm, ex] = await Promise.all([
    prisma.dmLog.findMany({ where: { workspaceId, status: { in: ["SENT", "FAILED"] }, createdAt: { gte: since } } }),
    prisma.triggerExecution.findMany({ where: { workspaceId, status: { in: ["SENT", "FAILED"] }, createdAt: { gte: since } } }),
  ]);
  const rows = [...(dm as Array<{ status: string }>), ...(ex as Array<{ status: string }>)];
  return rateSample(rows.filter((r) => r.status === "FAILED").length, rows.length);
}

/** createdAt - timestamp of Instagram events received since `since` (how late the webhook arrived). */
export async function loadWebhookDelay(workspaceId: string, since: Date): Promise<{ avgMs: number | null; maxMs: number | null; samples: number }> {
  const events = (await prisma.instagramEvent.findMany({
    where: { workspaceId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 500,
  })) as unknown as Array<{ createdAt: Date; timestamp: Date }>;
  const delays = events.map((e) => Math.max(0, e.createdAt.getTime() - e.timestamp.getTime()));
  if (delays.length === 0) return { avgMs: null, maxMs: null, samples: 0 };
  return {
    avgMs: Math.round(delays.reduce((s, d) => s + d, 0) / delays.length),
    maxMs: Math.max(...delays),
    samples: delays.length,
  };
}

/** LLM call results since `since`. */
export async function loadLlmRate(workspaceId: string, since: Date): Promise<RateSample & { avgLatencyMs: number | null }> {
  const rows = (await prisma.llmUsage.findMany({ where: { workspaceId, createdAt: { gte: since } } })) as unknown as Array<{ ok: boolean; latencyMs: number }>;
  const failures = rows.filter((r) => !r.ok).length;
  const avgLatencyMs = rows.length ? Math.round(rows.reduce((s, r) => s + (Number(r.latencyMs) || 0), 0) / rows.length) : null;
  return { ...rateSample(failures, rows.length), avgLatencyMs };
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

async function loadConnectionsKpi(workspaceId: string, now: Date): Promise<KpiData["connections"]> {
  const list = await loadConnections(workspaceId, now);
  const healthy = list.filter((c) => c.status === "CONNECTED" || c.status === "EXPIRING").length;
  return { total: list.length, healthy, broken: list.length - healthy };
}

async function loadActiveCampaigns(workspaceId: string): Promise<KpiData["activeCampaigns"]> {
  const [automations, triggers] = await Promise.all([
    prisma.automation.count({ where: { workspaceId, isActive: true } }),
    prisma.triggerCampaign.count({ where: { workspaceId, active: true } }),
  ]);
  return { automations, triggers, total: automations + triggers };
}

/** Outgoing messages per minute over the last 10 minutes, with a per-minute sparkline (oldest first). */
export async function loadMessagesPerMin(workspaceId: string, now: Date): Promise<NonNullable<KpiData["messagesPerMin"]>> {
  const since = new Date(now.getTime() - 10 * MINUTE_MS);
  const range = { gte: since, lte: now };
  const [dm, ex, fu, msgs, bc] = await Promise.all([
    prisma.dmLog.findMany({ where: { workspaceId, status: "SENT", dmSentAt: range } }),
    prisma.triggerExecution.findMany({ where: { workspaceId, status: "SENT", sentAt: range } }),
    prisma.triggerFollowUpRun.findMany({ where: { workspaceId, status: "SENT", sentAt: range } }),
    prisma.conversationMessage.findMany({ where: { createdAt: range, author: { in: ["ASSISTANT", "OPERATOR"] }, conversation: { workspaceId } } }),
    loadBroadcastSends(workspaceId, range),
  ]);
  const times: Date[] = [
    ...(dm as unknown as Array<{ dmSentAt: Date }>).map((r) => r.dmSentAt),
    ...(ex as unknown as Array<{ sentAt: Date }>).map((r) => r.sentAt),
    ...(fu as unknown as Array<{ sentAt: Date }>).map((r) => r.sentAt),
    ...(msgs as unknown as Array<{ createdAt: Date }>).map((r) => r.createdAt),
    ...bc,
  ].filter((t): t is Date => t instanceof Date);
  const sparkline = Array.from({ length: 10 }, () => 0);
  for (const t of times) {
    const bucket = Math.min(9, Math.max(0, Math.floor((t.getTime() - since.getTime()) / MINUTE_MS)));
    sparkline[bucket] += 1;
  }
  return { perMin: Math.round((times.length / 10) * 10) / 10, last10min: times.length, sparkline };
}

async function loadBroadcastSends(workspaceId: string, range: { gte: Date; lte: Date }): Promise<Date[]> {
  const broadcasts = (await prisma.crmBroadcast.findMany({ where: { workspaceId } })) as unknown as Array<{ id: string }>;
  if (broadcasts.length === 0) return [];
  const rows = (await prisma.crmBroadcastRecipient.findMany({
    where: { broadcastId: { in: broadcasts.map((b) => b.id) }, status: "SENT", sentAt: range },
  })) as unknown as Array<{ sentAt: Date }>;
  return rows.map((r) => r.sentAt);
}

async function loadErrorCounts(workspaceId: string, now: Date): Promise<NonNullable<KpiData["errors"]>> {
  const since24h = new Date(now.getTime() - DAY_MS);
  const [dm, events, system, webhook] = await Promise.all([
    prisma.dmLog.findMany({ where: { workspaceId, status: "FAILED", updatedAt: { gte: since24h } } }),
    prisma.instagramEvent.findMany({ where: { workspaceId, processingStatus: "FAILED", updatedAt: { gte: since24h } } }),
    prisma.operationalEvent.findMany({ where: { workspaceId, level: "ERROR", createdAt: { gte: since24h } } }),
    prisma.webhookEvent.findMany({ where: { workspaceId, status: "FAILED", createdAt: { gte: since24h } } }),
  ]);
  const stamps = [
    ...(dm as unknown as Array<{ updatedAt: Date }>).map((r) => r.updatedAt),
    ...(events as unknown as Array<{ updatedAt: Date }>).map((r) => r.updatedAt),
    ...(system as unknown as Array<{ createdAt: Date }>).map((r) => r.createdAt),
    ...(webhook as unknown as Array<{ createdAt: Date }>).map((r) => r.createdAt),
  ];
  const since1h = now.getTime() - HOUR_MS;
  return { last24h: stamps.length, last1h: stamps.filter((t) => t.getTime() >= since1h).length };
}

async function loadQueueDepths(): Promise<QueueDepth[]> {
  // Lazy imports: these modules open Redis connections only when called.
  const [{ getDMQueue }, { getAssistantQueue }, { getTriggerQueue }, { getJavobAiQueue }, { getCrmQueue }, { getAnalyticsQueue }] = await Promise.all([
    import("@/lib/queue/client"),
    import("@/lib/queue/assistant-queue"),
    import("@/lib/triggers/queue"),
    import("@/lib/javobai/queue"),
    import("@/lib/crm/queue"),
    import("./queue"),
  ]);
  const queues: Array<[string, string, { getJobCounts: (...types: JobType[]) => Promise<Record<string, number>> }]> = [
    ["dm-processing", "Comment DM", getDMQueue()],
    ["lead-assistant", "Lead assistent", getAssistantQueue()],
    ["instagram-triggers", "Trigger'lar", getTriggerQueue()],
    ["javobai", "JavobAI", getJavobAiQueue()],
    ["crm", "CRM", getCrmQueue()],
    ["analytics", "Analitika", getAnalyticsQueue()],
  ];
  const results = await Promise.all(
    queues.map(async ([queue, label, q]) => {
      const counts = await withTimeout(q.getJobCounts("waiting", "active", "delayed", "failed"), 2000);
      if (!counts) return null;
      return { queue, label, waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0 };
    })
  );
  return results.filter((r): r is QueueDepth => r !== null);
}

async function loadTodayRollups(workspaceId: string, now: Date): Promise<NonNullable<KpiData["today"]>> {
  const rows = (await prisma.analyticsDaily.findMany({
    where: {
      workspaceId,
      instagramAccountId: "",
      dimKind: "",
      day: dayColumn(todayKey(now)),
      metric: { in: ["ai.conversations", "sales.leads", "ai.hot", "sales.won"] },
    },
  })) as unknown as Array<{ metric: string; value: unknown }>;
  const at = (metric: string) => Number(rows.find((r) => r.metric === metric)?.value) || 0;
  return { aiConversations: at("ai.conversations"), leads: at("sales.leads"), hot: at("ai.hot"), conversions: at("sales.won") };
}

async function loadAiToday(workspaceId: string, now: Date): Promise<number> {
  const start = new Date(new Date(`${todayKey(now)}T00:00:00Z`).getTime() - 5 * HOUR_MS);
  const rows = (await prisma.llmUsage.findMany({ where: { workspaceId, createdAt: { gte: start } } })) as unknown as Array<{ costUsd: unknown }>;
  return Math.round(rows.reduce((s, r) => s + (Number(r.costUsd) || 0), 0) * 1_000_000) / 1_000_000;
}

export interface KpiDeps {
  loadQueueStats?: typeof loadQueueStats;
  getWorkerHealth?: typeof getWorkerHealth;
  loadQueueDepths?: typeof loadQueueDepths;
}

/** All KPI tiles for one workspace. Never throws. */
export async function loadKpi(workspaceId: string, now: Date = new Date(), deps: KpiDeps = {}): Promise<KpiData> {
  const failed: string[] = [];
  const run = async <T>(key: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (error) {
      failed.push(key);
      console.error(`[Analytics] KPI loader ${key} failed:`, error instanceof Error ? error.message : error);
      return null;
    }
  };
  const since1h = new Date(now.getTime() - HOUR_MS);
  const since24h = new Date(now.getTime() - DAY_MS);
  const queueStats = deps.loadQueueStats ?? loadQueueStats;
  const workerHealth = deps.getWorkerHealth ?? getWorkerHealth;
  const queueDepths = deps.loadQueueDepths ?? loadQueueDepths;

  const [connections, activeCampaigns, messagesPerMin, queue, depths, errors, metaErrorRate, llm, aiCost, success, webhookDelay, today, worker] = await Promise.all([
    run("connections", () => loadConnectionsKpi(workspaceId, now)),
    run("activeCampaigns", () => loadActiveCampaigns(workspaceId)),
    run("messagesPerMin", () => loadMessagesPerMin(workspaceId, now)),
    run("queue", async () => {
      const stats = await queueStats(workspaceId, { now });
      return { dm: stats.dm, triggerBacklog: stats.triggers.backlog };
    }),
    run("queueDepths", async () => {
      const result = await withTimeout(queueDepths(), 4000);
      if (!result) throw new Error("queue depth timeout");
      return result;
    }),
    run("errors", () => loadErrorCounts(workspaceId, now)),
    run("metaErrorRate", () => loadMetaSendRate(workspaceId, since1h)),
    run("aiLatencyMs", () => loadLlmRate(workspaceId, since1h)),
    run("aiCostTodayUsd", () => loadAiToday(workspaceId, now)),
    run("messageSuccessRate", async () => {
      const sample = await loadMetaSendRate(workspaceId, since24h);
      return rateSample(sample.failures, sample.attempts, "success");
    }),
    run("webhookDelay", () => loadWebhookDelay(workspaceId, since1h)),
    run("today", () => loadTodayRollups(workspaceId, now)),
    run("worker", async () => {
      const health = await withTimeout(workerHealth(), 2000);
      if (!health) throw new Error("worker health unavailable");
      return { healthy: health.healthy, ageMs: health.ageMs };
    }),
  ]);

  return {
    generatedAt: now.toISOString(),
    connections,
    activeCampaigns,
    messagesPerMin,
    queue,
    queueDepths: depths,
    errors,
    metaErrorRate,
    aiLatencyMs: llm ? { avg: llm.avgLatencyMs, calls: llm.attempts } : null,
    aiCostTodayUsd: aiCost,
    messageSuccessRate: success,
    webhookDelay,
    today,
    worker,
    failed,
  };
}
