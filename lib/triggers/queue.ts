/**
 * The trigger engine's own BullMQ queue — separate from "dm-processing" and
 * "lead-assistant", so a problem here can never hold up the live product.
 *
 * One job = one InstagramEvent id. The job carries no event data: the row in
 * Postgres is the source of truth, which is what lets a lost job be recovered
 * by the sweep (lib/triggers/worker.ts) without losing anything.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";

export const TRIGGER_QUEUE_NAME = "instagram-triggers";
export const PROCESS_EVENT_JOB = "process-event";

/** Attempts per job, the first one included. */
export const TRIGGER_MAX_ATTEMPTS = 5;
/** Wait before retry n (1-based): 30s, 2m, 10m, 30m. */
export const TRIGGER_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];

/**
 * Wait after a rate-limit denial. The per-account DM cap is a one-hour window
 * (lib/utils/rate-limiter.ts), so the normal backoff (~42 min in total) would
 * burn every attempt inside one window. Wait past the window instead.
 */
export const TRIGGER_RATE_LIMIT_BACKOFF_MS = 65 * 60_000;

/** Computed rate-limit waits are kept inside this range (never a busy loop, never longer than the fixed 65 min). */
const RATE_LIMIT_MIN_DELAY_MS = 30_000;

export function backoffDelay(attemptsMade: number, kind?: string, retryAfterMs?: number): number {
  if (kind === "rate_limit") {
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(TRIGGER_RATE_LIMIT_BACKOFF_MS, Math.max(RATE_LIMIT_MIN_DELAY_MS, retryAfterMs));
    }
    return TRIGGER_RATE_LIMIT_BACKOFF_MS;
  }
  return TRIGGER_BACKOFF_MS[Math.min(Math.max(attemptsMade, 1) - 1, TRIGGER_BACKOFF_MS.length - 1)];
}

export interface ProcessEventJob {
  eventId: string;
}

let queue: Queue<ProcessEventJob> | null = null;

export function getTriggerQueue(): Queue<ProcessEventJob> {
  if (!queue) {
    queue = new Queue<ProcessEventJob>(TRIGGER_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: TRIGGER_MAX_ATTEMPTS,
        backoff: { type: "custom" },
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
      },
    });
  }
  return queue;
}

/**
 * `suffix` makes the job id unique for sweeps and manual retries. Without it
 * the id is deterministic, so enqueueing the same event twice is a no-op.
 */
export async function enqueueEvent(eventId: string, options: { suffix?: string } = {}) {
  const jobId = options.suffix ? `evt_${eventId}_${options.suffix}` : `evt_${eventId}`;
  await getTriggerQueue().add(
    PROCESS_EVENT_JOB,
    { eventId },
    { jobId }
  );
}
