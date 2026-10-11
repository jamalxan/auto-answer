import { Worker } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { TriggerRetryableError } from "./errors";
import { PROCESSING_LEASE_MS, processInstagramEvent } from "./processor";
import {
  backoffDelay,
  enqueueEvent,
  TRIGGER_BACKOFF_MS,
  TRIGGER_QUEUE_NAME,
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
      settings: { backoffStrategy: (attemptsMade: number) => backoffDelay(attemptsMade) },
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
const RETRY_GRACE_MS = TRIGGER_BACKOFF_MS[TRIGGER_BACKOFF_MS.length - 1] + 15 * 60_000;
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

export async function runTriggerMaintenance(): Promise<void> {
  try {
    const requeued = await sweepTriggerEvents();
    if (requeued > 0) console.log(`[Trigger Engine] sweep re-queued ${requeued} event(s)`);
  } catch (error) {
    console.error("[Trigger Engine] sweep failed:", error instanceof Error ? error.message : error);
  }
}
