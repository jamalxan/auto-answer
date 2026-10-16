import { Worker } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { TriggerRetryableError } from "./errors";
import { runDueFollowUps } from "./followups";
import { LOG_ONLY_RETENTION_DAYS, logOnlyEventWhere } from "./normalize";
import { PROCESSING_LEASE_MS, processInstagramEvent } from "./processor";
import {
  backoffDelay,
  enqueueEvent,
  TRIGGER_BACKOFF_MS,
  TRIGGER_QUEUE_NAME,
  TRIGGER_RATE_LIMIT_BACKOFF_MS,
  type ProcessEventJob,
} from "./queue";

export function createTriggerWorker(): Worker<ProcessEventJob> {
  const worker = new Worker<ProcessEventJob>(
    TRIGGER_QUEUE_NAME,
    async (job) => {
      const outcome = await processInstagramEvent(job.data.eventId);
      return { outcome };
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
      settings: {
        backoffStrategy: (attemptsMade: number, _type?: string, err?: Error) =>
          err instanceof TriggerRetryableError
            ? backoffDelay(attemptsMade, err.failure.kind, err.failure.retryAfterMs)
            : backoffDelay(attemptsMade, undefined),
      },
    }
  );

  worker.on("failed", (job, err) => {
    // A planned retry is already recorded on the event and its execution.
    if (err instanceof TriggerRetryableError) return;
    console.error(`[Trigger Engine] job ${job?.id} failed:`, err.stack ?? err.message);
  });
  worker.on("error", (err) => console.error("[Trigger Engine] worker error:", err.message));

  return worker;
}

const PENDING_GRACE_MS = 2 * 60_000;
// Longest backoff plus slack: a RETRYING event older than this lost its job.
const RETRY_GRACE_MS =
  Math.max(TRIGGER_BACKOFF_MS[TRIGGER_BACKOFF_MS.length - 1], TRIGGER_RATE_LIMIT_BACKOFF_MS) + 15 * 60_000;
const SWEEP_LIMIT = 100;

/**
 * Re-queue events whose job is gone: never enqueued (Redis was down at
 * webhook time), claimed by a worker that crashed, or a retry lost in a Redis
 * flush. The processor's claim makes an extra job harmless.
 */
export async function sweepTriggerEvents(now = new Date()): Promise<number> {
  const stuck = await prisma.instagramEvent.findMany({
    where: {
      OR: [
        { processingStatus: "PENDING", createdAt: { lt: new Date(now.getTime() - PENDING_GRACE_MS) } },
        {
          processingStatus: "PROCESSING",
          processingStartedAt: { lt: new Date(now.getTime() - PROCESSING_LEASE_MS) },
        },
        { processingStatus: "RETRYING", updatedAt: { lt: new Date(now.getTime() - RETRY_GRACE_MS) } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: SWEEP_LIMIT,
  });

  for (const event of stuck) {
    await enqueueEvent(event.id, { suffix: `sweep${now.getTime()}` });
  }
  return stuck.length;
}

/**
 * Runs every minute from the worker process (worker/dm-worker.ts), only when
 * the engine is enabled; the interval is cleared on shutdown.
 *   1. sweep: re-queue events whose job was lost;
 *   2. Comment 2.0 follow-ups that are due (lib/triggers/followups.ts).
 */
const LOG_ONLY_BATCH = 1000;
const LOG_ONLY_SWEEP_EVERY_MS = 10 * 60_000;
let lastLogOnlySweepAt = 0;

/**
 * M2 retention: log-only rows (IGNORED + "no automation", see ingest.ts) are
 * only a log line; delete the ones older than LOG_ONLY_RETENTION_DAYS, at most
 * `LOG_ONLY_BATCH` rows per pass (the next pass continues). Returns the count.
 */
export async function sweepLogOnlyEvents(now = new Date()): Promise<number> {
  const olderThan = new Date(now.getTime() - LOG_ONLY_RETENTION_DAYS * 24 * 3600_000);
  const rows = await prisma.instagramEvent.findMany({
    where: { ...logOnlyEventWhere(), createdAt: { lt: olderThan } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: LOG_ONLY_BATCH,
  });
  if (rows.length === 0) return 0;
  const { count } = await prisma.instagramEvent.deleteMany({
    where: { id: { in: rows.map((row) => row.id) }, ...logOnlyEventWhere() },
  });
  return count;
}

export async function runTriggerMaintenance(): Promise<void> {
  if (Date.now() - lastLogOnlySweepAt >= LOG_ONLY_SWEEP_EVERY_MS) {
    lastLogOnlySweepAt = Date.now();
    try {
      const removed = await sweepLogOnlyEvents();
      if (removed > 0) console.log(`[Trigger Engine] retention removed ${removed} log-only event(s)`);
    } catch (error) {
      console.error("[Trigger Engine] log-only retention failed:", error instanceof Error ? error.message : error);
    }
  }
  try {
    const requeued = await sweepTriggerEvents();
    if (requeued > 0) console.log(`[Trigger Engine] sweep re-queued ${requeued} event(s)`);
  } catch (error) {
    console.error("[Trigger Engine] sweep failed:", error instanceof Error ? error.message : error);
  }
  try {
    const followUps = await runDueFollowUps();
    const handled = Object.values(followUps).reduce((sum, n) => sum + n, 0);
    if (handled > 0) console.log("[Trigger Engine] follow-ups:", JSON.stringify(followUps));
  } catch (error) {
    console.error("[Trigger Engine] follow-up sweep failed:", error instanceof Error ? error.message : error);
  }
}
