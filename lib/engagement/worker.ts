/**
 * The "engagement" queue's worker. Registered in worker/dm-worker.ts next to
 * the other workers, with the same shutdown pattern; not created at all with
 * ENGAGEMENT_DISABLED=1. Concurrency 2: a backfill is one long Graph scan and
 * a notification a handful of sends, and the collector runs in the
 * maintenance tick, so more workers would only race the same entries.
 *
 * Other engagement modules (referral) plug in without editing this file:
 *   registerEngagementJobHandler("referral-reward", fn)
 *   registerEngagementMaintenanceTask("referral", fn)
 */

import { Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { COLLECT_MIN_INTERVAL_MS, isEngagementEnabled } from "./config";
import { failBackfill, runBackfill } from "./giveaway/backfill";
import { runGiveawayCollector } from "./giveaway/collector";
import { notifyWinners } from "./giveaway/notify";
import {
  ENGAGEMENT_QUEUE_NAME,
  GIVEAWAY_BACKFILL_JOB,
  GIVEAWAY_NOTIFY_JOB,
  type EngagementJob,
  type GiveawayBackfillJob,
  type GiveawayNotifyJob,
} from "./queue";

export { isEngagementEnabled } from "./config";

type JobHandler = (job: Job<EngagementJob>) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

/** Add a job name to the worker (the registering module owns the job's data shape). */
export function registerEngagementJobHandler(name: string, handler: JobHandler): () => void {
  handlers.set(name, handler);
  return () => void handlers.delete(name);
}

type MaintenanceTask = () => Promise<void>;

const maintenanceTasks = new Map<string, MaintenanceTask>();

/** Run on every maintenance tick (about once a minute from the worker process); the task throttles itself. */
export function registerEngagementMaintenanceTask(name: string, task: MaintenanceTask): () => void {
  maintenanceTasks.set(name, task);
  return () => void maintenanceTasks.delete(name);
}

async function processJob(job: Job<EngagementJob>): Promise<unknown> {
  if (!isEngagementEnabled()) return { skipped: "ENGAGEMENT_DISABLED" };
  if (job.name === GIVEAWAY_BACKFILL_JOB) {
    const data = job.data as GiveawayBackfillJob;
    return runBackfill(data.workspaceId, data.giveawayId);
  }
  if (job.name === GIVEAWAY_NOTIFY_JOB) {
    const data = job.data as GiveawayNotifyJob;
    return notifyWinners(data.workspaceId, data.giveawayId, data.sequence);
  }
  const handler = handlers.get(job.name);
  if (handler) return handler(job);
  console.warn(`[Engagement Worker] no handler for job ${job.name}`);
  return { skipped: "unknown job" };
}

export function createEngagementWorker(): Worker<EngagementJob> {
  const worker = new Worker<EngagementJob>(ENGAGEMENT_QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency: 2,
  });

  worker.on("failed", (job, err) => {
    console.error(`[Engagement Worker] job ${job?.id} (${job?.name}) failed:`, err.stack ?? err.message);
    if (job?.name === GIVEAWAY_BACKFILL_JOB) {
      const giveawayId = (job.data as GiveawayBackfillJob).giveawayId;
      void failBackfill(giveawayId, `Izohlarni yuklash to'xtadi: ${err.message}`);
    }
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `Engagement job ${job?.name ?? "?"} failed: ${err.message}`.slice(0, 500),
          payload: { jobId: job?.id ?? null },
        },
      })
      .catch(() => {});
  });

  worker.on("error", (err) => {
    console.error("[Engagement Worker] error:", err.message);
  });

  return worker;
}

let lastRunAt = 0;
let running = false;

/**
 * Called once a minute from worker/dm-worker.ts: the giveaway collector, then
 * every registered task. Self-throttled (COLLECT_MIN_INTERVAL_MS) and
 * non-reentrant; a no-op with ENGAGEMENT_DISABLED=1.
 */
export async function runEngagementMaintenance(options: { force?: boolean; now?: Date } = {}): Promise<void> {
  if (!isEngagementEnabled()) return;
  const now = options.now?.getTime() ?? Date.now();
  if (running || (!options.force && now - lastRunAt < COLLECT_MIN_INTERVAL_MS)) return;
  running = true;
  lastRunAt = now;
  try {
    try {
      const summary = await runGiveawayCollector(new Date(now));
      if (summary.created || summary.updated || summary.followChecks) console.log("[Engagement] collector:", JSON.stringify(summary));
    } catch (error) {
      console.error("[Engagement] collector failed:", error instanceof Error ? error.message : error);
    }
    for (const [name, task] of maintenanceTasks) {
      try {
        await task();
      } catch (error) {
        console.error(`[Engagement] maintenance task ${name} failed:`, error instanceof Error ? error.message : error);
      }
    }
  } finally {
    running = false;
  }
}

/** Tests: forget the throttle so the next call runs. */
export function resetEngagementMaintenanceForTests(): void {
  lastRunAt = 0;
  running = false;
}
