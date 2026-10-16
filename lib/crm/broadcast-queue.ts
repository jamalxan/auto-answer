/**
 * ETAP 5.4 — the broadcast engine's jobs on the shared "crm" queue
 * (lib/crm/queue.ts); the handlers are registered with the CRM worker's
 * registry (lib/crm/worker.ts registerCrmJobHandler) from broadcast-worker.ts.
 *
 *   broadcast-start  SCHEDULED → RUNNING: materialise the audience, first batch
 *   broadcast-batch  send up to batchSize(throttlePerHour) PENDING recipients
 *
 * Jobs carry the broadcast id (and a batch its tick number): the rows in
 * Postgres are the truth. Every scheduled tick bumps CrmBroadcast.tickSeq and
 * gets the deterministic job id bcb_<id>_<tickSeq>; a tick whose number is no
 * longer the row's stops without sending, so pause / resume / the maintenance
 * sweep can never leave two delivery chains. The sweep re-enqueues a lost
 * chain from CrmBroadcast.nextTickAt (no queue scans), and every recipient is
 * leased, so nothing is sent twice.
 *
 * Opt-in (CRM_ENABLED=1); CRM_DISABLED=1 stops the worker and every enqueue.
 */

import type { Job } from "bullmq";
import { getCrmQueue, isCrmEnabled, type CrmJob } from "./queue";

export { isCrmEnabled } from "./queue";

export const BROADCAST_START_JOB = "broadcast-start";
export const BROADCAST_BATCH_JOB = "broadcast-batch";

/** One delivery tick per broadcast; batchSize(throttlePerHour) recipients per tick. */
export const BROADCAST_BATCH_INTERVAL_MS = 5 * 60_000;

export interface BroadcastJob {
  broadcastId: string;
  /** Batch jobs: the CrmBroadcast.tickSeq this tick was scheduled as. */
  tickSeq?: number | null;
}

/** BullMQ forbids ":" in custom job ids. */
function safeId(value: string): string {
  return value.replace(/:/g, "_");
}

/** Deterministic: the same start (schedule time) or the same tick is one job, however often it is enqueued. */
function jobId(prefix: string, broadcastId: string, key: string | number): string {
  return safeId(`${prefix}_${broadcastId}_${key}`);
}

// A failed tick is picked up by the maintenance sweep, never retried blindly
// (the queue's default is 3 attempts with backoff).
const JOB_OPTIONS = { attempts: 1, removeOnComplete: { count: 500 }, removeOnFail: { age: 24 * 3600, count: 500 } };

/** `scheduledAt` keys the job: re-enqueueing the same start (maintenance sweep) is a no-op while it exists. */
export async function enqueueBroadcastStart(broadcastId: string, delayMs = 0, scheduledAt: Date | null = null): Promise<void> {
  if (!isCrmEnabled()) return;
  await getCrmQueue().add(BROADCAST_START_JOB, { broadcastId } as unknown as CrmJob, {
    ...JOB_OPTIONS,
    delay: Math.max(0, delayMs),
    jobId: jobId("bc", broadcastId, scheduledAt ? scheduledAt.getTime() : "now"),
  });
}

/** One tick of the delivery chain; `tickSeq` is the number broadcast.ts scheduleTick reserved on the row. */
export async function enqueueBroadcastBatch(broadcastId: string, delayMs: number, tickSeq: number): Promise<void> {
  if (!isCrmEnabled()) return;
  await getCrmQueue().add(BROADCAST_BATCH_JOB, { broadcastId, tickSeq } as unknown as CrmJob, {
    ...JOB_OPTIONS,
    delay: Math.max(0, delayMs),
    jobId: jobId("bcb", broadcastId, tickSeq),
  });
}

const LIVE_STATES = ["waiting", "delayed", "active", "prioritized", "waiting-children"] as const;
const BROADCAST_JOBS: readonly string[] = [BROADCAST_START_JOB, BROADCAST_BATCH_JOB];

async function jobsOf(broadcastId: string): Promise<Job<CrmJob>[]> {
  const jobs = await getCrmQueue().getJobs([...LIVE_STATES], 0, 2000);
  return jobs.filter((job) => job && BROADCAST_JOBS.includes(job.name) && (job.data as Partial<BroadcastJob>)?.broadcastId === broadcastId);
}

/** Drops every waiting / delayed job of the broadcast (pause, cancel, reschedule). An active one finishes its tick and stops on its own. */
export async function removeBroadcastJobs(broadcastId: string): Promise<number> {
  const jobs = await jobsOf(broadcastId);
  let removed = 0;
  for (const job of jobs) {
    const state = await job.getState().catch(() => "unknown");
    if (state === "active") continue;
    await job.remove().catch(() => {});
    removed++;
  }
  return removed;
}
