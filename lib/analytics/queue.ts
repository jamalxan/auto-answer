/**
 * ETAP 10 - the "analytics" BullMQ queue. Separate from "dm-processing",
 * "lead-assistant", "instagram-triggers", "javobai" and "crm" so a long
 * backfill can never hold up a reply.
 *
 *   analytics-backfill   recompute the last N days of one workspace (POST .../backfill)
 *   analytics-recompute  recompute an explicit from..to range of one workspace
 *
 * Kill switch: ANALYTICS_DISABLED=1 stops the worker, the maintenance tick
 * (rollups and alerts) and the enqueue routes; the stored rollups stay readable.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";

export const ANALYTICS_QUEUE_NAME = "analytics";
export const ANALYTICS_BACKFILL_JOB = "analytics-backfill";
export const ANALYTICS_RECOMPUTE_JOB = "analytics-recompute";

export const MAX_BACKFILL_DAYS = 366;
export const DEFAULT_BACKFILL_DAYS = 90;

function envFlag(name: string): boolean {
  const flag = (process.env[name] ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

export function isAnalyticsEnabled(): boolean {
  return !envFlag("ANALYTICS_DISABLED");
}

/** Jobs need Redis to be handed over; without it (unit tests, scripts) enqueueing is refused. */
export function hasAnalyticsQueueBackend(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

export interface AnalyticsBackfillJob {
  workspaceId: string;
  days: number;
  requestedBy?: string | null;
}

export interface AnalyticsRecomputeJob {
  workspaceId: string;
  from: string;
  to: string;
  requestedBy?: string | null;
}

export type AnalyticsJob = AnalyticsBackfillJob | AnalyticsRecomputeJob;

let queue: Queue<AnalyticsJob> | null = null;

export function getAnalyticsQueue(): Queue<AnalyticsJob> {
  if (!queue) {
    queue = new Queue<AnalyticsJob>(ANALYTICS_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 200 },
        removeOnFail: { age: 24 * 3600, count: 200 },
        attempts: 2,
        backoff: { type: "exponential", delay: 10_000 },
      },
    });
  }
  return queue;
}

/** One backfill per workspace at a time: a second request while one waits or runs is a no-op. */
export async function enqueueAnalyticsBackfill(job: AnalyticsBackfillJob): Promise<{ queued: boolean }> {
  const days = Math.min(MAX_BACKFILL_DAYS, Math.max(1, Math.floor(job.days) || DEFAULT_BACKFILL_DAYS));
  const jobId = `analytics-backfill_${job.workspaceId}`;
  const q = getAnalyticsQueue();
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState().catch(() => "unknown");
    if (state === "waiting" || state === "active" || state === "delayed") return { queued: false };
    await existing.remove().catch(() => {});
  }
  await q.add(ANALYTICS_BACKFILL_JOB, { ...job, days }, { jobId, attempts: 1 });
  return { queued: true };
}

export async function enqueueAnalyticsRecompute(job: AnalyticsRecomputeJob): Promise<void> {
  await getAnalyticsQueue().add(ANALYTICS_RECOMPUTE_JOB, job, { attempts: 1 });
}
