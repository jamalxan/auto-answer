/**
 * User-visible queue (TZ §6.2): Queued / Processing / Completed / Failed /
 * Estimated time for one workspace, plus per-account hourly rate usage.
 *
 * The DM queue is shared by every workspace, so its global counts would leak
 * other customers' volume. Waiting/active jobs are therefore read and filtered
 * by the workspace's Instagram ids (scan capped at QUEUE_SCAN_LIMIT), and
 * completed/failed come from DmLog, which is workspace-scoped already.
 *
 * Redis can be down: every Redis read is time-boxed and reported as null
 * ("noma'lum") rather than failing the whole page.
 */

import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { defaultHourlyLimit, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW } from "@/lib/utils/rate-limiter";
import type { DisplayTone } from "@/lib/triggers/display";
import { formatMinutes, withTimeout } from "./time";

export const QUEUE_SCAN_LIMIT = 2000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * Minutes until `queued` items drain at `throughputPerHour`. 0 when nothing
 * waits; null when it cannot be estimated (nothing sent recently).
 */
export function estimateEtaMinutes(queued: number, throughputPerHour: number): number | null {
  if (!Number.isFinite(queued) || queued <= 0) return 0;
  if (!Number.isFinite(throughputPerHour) || throughputPerHour <= 0) return null;
  return Math.ceil((queued / throughputPerHour) * 60);
}

export function formatEta(minutes: number | null): string {
  if (minutes === null) return "Hisoblab bo'lmadi";
  if (minutes === 0) return "Navbat bo'sh";
  return `~${formatMinutes(minutes)}`;
}

export interface RateUsage {
  used: number;
  limit: number;
  remaining: number;
  percent: number;
  /** Seconds until the hourly counter resets; null when no window is open. */
  resetInSeconds: number | null;
  tone: DisplayTone;
}

/** One `rate:dm:<instagramId>` counter + its TTL → usage. */
export function buildRateUsage(used: number, ttlSeconds: number | null, limit = RATE_LIMIT_MAX): RateUsage {
  const safeUsed = Math.max(0, Number.isFinite(used) ? used : 0);
  const percent = limit > 0 ? Math.min(100, Math.round((safeUsed / limit) * 100)) : 0;
  return {
    used: safeUsed,
    limit,
    remaining: Math.max(0, limit - safeUsed),
    percent,
    // Redis TTL: -2 = no key, -1 = no expiry; neither is a running window.
    resetInSeconds: ttlSeconds !== null && ttlSeconds >= 0 ? Math.min(ttlSeconds, RATE_LIMIT_WINDOW) : null,
    tone: percent >= 100 ? "error" : percent >= 80 ? "warning" : "success",
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────

export interface AccountRateUsage {
  instagramAccountId: string;
  username: string;
  /** null when Redis did not answer. */
  usage: RateUsage | null;
}

export interface QueueStats {
  dm: {
    /** Waiting + delayed jobs for this workspace; null = Redis unavailable. */
    queued: number | null;
    processing: number | null;
    /** True when the scan hit QUEUE_SCAN_LIMIT, so `queued` is a floor. */
    truncated: boolean;
    completed24h: number;
    failed24h: number;
    skipped24h: number;
    sentLastHour: number;
    etaMinutes: number | null;
    etaLabel: string;
  };
  triggers: {
    /** PENDING + PROCESSING + RETRYING right now. */
    backlog: number;
    last24h: Record<string, number>;
  };
  rate: AccountRateUsage[];
  checkedAt: string;
}

export interface QueueAccount {
  id: string;
  username: string;
  instagramId: string;
  /** Per-account hourly DM cap override (null/absent = DM_HOURLY_LIMIT_DEFAULT). */
  dmHourlyLimit?: number | null;
}

async function scanDmQueue(instagramIds: Set<string>) {
  const queue = getDMQueue();
  const [waiting, active] = await Promise.all([
    queue.getJobs(["waiting", "delayed", "prioritized"], 0, QUEUE_SCAN_LIMIT - 1),
    queue.getJobs(["active"], 0, QUEUE_SCAN_LIMIT - 1),
  ]);
  const mine = (jobs: typeof waiting) =>
    jobs.filter((job) => job && instagramIds.has(String(job.data?.instagramAccountId ?? ""))).length;
  return {
    queued: mine(waiting),
    processing: mine(active),
    truncated: waiting.length >= QUEUE_SCAN_LIMIT,
  };
}

async function readRateCounters(accounts: QueueAccount[]) {
  if (accounts.length === 0) return [];
  const pipeline = getRedisConnection().pipeline();
  for (const account of accounts) {
    // Keyed by the Instagram id (what the DM worker and trigger engine pass
    // to reserveDMSlot), not by our row id.
    pipeline.get(`rate:dm:${account.instagramId}`);
    pipeline.ttl(`rate:dm:${account.instagramId}`);
  }
  const results = (await pipeline.exec()) ?? [];
  return accounts.map((account, i) => {
    const count = results[i * 2]?.[1];
    const ttl = results[i * 2 + 1]?.[1];
    return buildRateUsage(
      Number.parseInt(typeof count === "string" ? count : "0", 10) || 0,
      typeof ttl === "number" ? ttl : null,
      account.dmHourlyLimit && account.dmHourlyLimit > 0 ? account.dmHourlyLimit : defaultHourlyLimit()
    );
  });
}

export async function loadQueueStats(
  workspaceId: string,
  options: { accounts?: QueueAccount[]; now?: Date } = {}
): Promise<QueueStats> {
  const now = options.now ?? new Date();
  const since24h = new Date(now.getTime() - DAY_MS);
  const since1h = new Date(now.getTime() - HOUR_MS);

  const accounts =
    options.accounts ??
    (await prisma.instagramAccount.findMany({
      where: { workspaceId },
      select: { id: true, username: true, instagramId: true, dmHourlyLimit: true },
      orderBy: { connectedAt: "desc" },
    }));
  const instagramIds = new Set(accounts.map((a) => a.instagramId));

  const [dmByStatus, sentLastHour, triggerBacklog, triggerByStatus, scan, counters] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["status"],
      where: { workspaceId, updatedAt: { gte: since24h } },
      _count: { _all: true },
    }),
    prisma.dmLog.count({ where: { workspaceId, status: "SENT", dmSentAt: { gte: since1h } } }),
    prisma.instagramEvent.count({
      where: { workspaceId, processingStatus: { in: ["PENDING", "PROCESSING", "RETRYING"] } },
    }),
    prisma.instagramEvent.groupBy({
      by: ["processingStatus"],
      where: { workspaceId, createdAt: { gte: since24h } },
      _count: { _all: true },
    }),
    instagramIds.size > 0 ? withTimeout(scanDmQueue(instagramIds), 2500) : Promise.resolve({ queued: 0, processing: 0, truncated: false }),
    withTimeout(readRateCounters(accounts)),
  ]);

  const dmCount = (status: string) => dmByStatus.find((row) => row.status === status)?._count._all ?? 0;
  const skipped24h = dmByStatus
    .filter((row) => row.status.startsWith("SKIPPED_"))
    .reduce((sum, row) => sum + row._count._all, 0);

  const queued = scan?.queued ?? null;
  const etaMinutes = queued === null ? null : estimateEtaMinutes(queued, sentLastHour);

  return {
    dm: {
      queued,
      processing: scan?.processing ?? null,
      truncated: scan?.truncated ?? false,
      completed24h: dmCount("SENT"),
      failed24h: dmCount("FAILED"),
      skipped24h,
      sentLastHour,
      etaMinutes,
      etaLabel: queued === null ? "Noma'lum (Redis javob bermadi)" : formatEta(etaMinutes),
    },
    triggers: {
      backlog: triggerBacklog,
      last24h: Object.fromEntries(triggerByStatus.map((row) => [row.processingStatus, row._count._all])),
    },
    rate: accounts.map((account, i) => ({
      instagramAccountId: account.id,
      username: account.username,
      usage: counters?.[i] ?? null,
    })),
    checkedAt: now.toISOString(),
  };
}
