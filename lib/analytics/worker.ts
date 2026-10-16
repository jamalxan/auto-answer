/**
 * ETAP 10 - the "analytics" queue's worker and the maintenance tick.
 * Registered in worker/dm-worker.ts next to the other workers, with the same
 * shutdown pattern. Concurrency 1: rollups are read-heavy, one at a time is
 * plenty and never competes with replies for the database.
 *
 * Maintenance (called once a minute, throttles itself):
 *   - every 10 minutes: recompute yesterday + today of every active workspace;
 *   - every 5 minutes: evaluate the monitoring alerts (lib/analytics/alerts.ts).
 * The nightly trailing-3-day recompute runs from /api/cron/analytics-rollup.
 */

import { Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { runAlertsForAll } from "./alerts";
import {
  ANALYTICS_BACKFILL_JOB,
  ANALYTICS_QUEUE_NAME,
  ANALYTICS_RECOMPUTE_JOB,
  isAnalyticsEnabled,
  type AnalyticsBackfillJob,
  type AnalyticsJob,
  type AnalyticsRecomputeJob,
} from "./queue";
import { backfillWindow, incrementalDays, rollupAll, rollupRange } from "./rollup";

export { isAnalyticsEnabled } from "./queue";

export const ROLLUP_INTERVAL_MS = 10 * 60_000;
export const ALERT_INTERVAL_MS = 5 * 60_000;

async function processJob(job: Job<AnalyticsJob>): Promise<unknown> {
  if (!isAnalyticsEnabled()) return { skipped: "ANALYTICS_DISABLED" };
  if (job.name === ANALYTICS_BACKFILL_JOB) {
    const data = job.data as AnalyticsBackfillJob;
    const window = backfillWindow(data.days);
    const results = await rollupRange(data.workspaceId, window.from, window.to);
    return { days: results.length, rows: results.reduce((sum, r) => sum + r.rows, 0) };
  }
  if (job.name === ANALYTICS_RECOMPUTE_JOB) {
    const data = job.data as AnalyticsRecomputeJob;
    const results = await rollupRange(data.workspaceId, data.from, data.to);
    return { days: results.length };
  }
  console.warn(`[Analytics Worker] no handler for job ${job.name}`);
  return { skipped: "unknown job" };
}

export function createAnalyticsWorker(): Worker<AnalyticsJob> {
  const worker = new Worker<AnalyticsJob>(ANALYTICS_QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency: 1,
  });

  worker.on("failed", (job, err) => {
    console.error(`[Analytics Worker] job ${job?.id} (${job?.name}) failed:`, err.stack ?? err.message);
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `Analytics job ${job?.name ?? "?"} failed: ${err.message}`.slice(0, 500),
          payload: { jobId: job?.id ?? null },
        },
      })
      .catch(() => {});
  });

  worker.on("error", (err) => {
    console.error("[Analytics Worker] error:", err.message);
  });

  return worker;
}

let lastRollupAt = 0;
let rolling = false;
let lastAlertsAt = 0;
let alerting = false;

/** Called once a minute from worker/dm-worker.ts; each part throttles itself. */
export async function runAnalyticsMaintenance(options: { force?: boolean; now?: Date } = {}): Promise<void> {
  if (!isAnalyticsEnabled()) return;
  const now = options.now ?? new Date();
  const ms = now.getTime();

  if ((options.force || ms - lastRollupAt >= ROLLUP_INTERVAL_MS) && !rolling) {
    rolling = true;
    lastRollupAt = ms;
    try {
      const result = await rollupAll(incrementalDays(now), now);
      if (result.failed > 0) console.warn("[Analytics] incremental rollup:", JSON.stringify(result));
    } catch (error) {
      console.error("[Analytics] incremental rollup failed:", error instanceof Error ? error.message : error);
    } finally {
      rolling = false;
    }
  }

  if ((options.force || ms - lastAlertsAt >= ALERT_INTERVAL_MS) && !alerting) {
    alerting = true;
    lastAlertsAt = ms;
    try {
      await runAlertsForAll(now);
    } catch (error) {
      console.error("[Analytics] alerts failed:", error instanceof Error ? error.message : error);
    } finally {
      alerting = false;
    }
  }
}

/** Tests: forget the throttles. */
export function resetAnalyticsMaintenanceForTests(): void {
  lastRollupAt = 0;
  lastAlertsAt = 0;
  rolling = false;
  alerting = false;
}
