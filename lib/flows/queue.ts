/**
 * ETAP 6 — the flow engine's own BullMQ queue ("flows"), separate from
 * "dm-processing", "lead-assistant", "instagram-triggers", "javobai" and
 * "crm" so a flow problem can never hold up a reply or a delivery.
 *
 *   flow-resume    wake one run at its wait time (Delay done, button timeout,
 *                  retry after a failed send); `expectedSeq` makes a stale job a no-op
 *   flow-run-step  continue one ACTIVE run (the maintenance sweep for stuck runs)
 *
 * The run row in Postgres is the source of truth: a lost job is recovered by
 * `runFlowsMaintenance` (worker.ts), exactly like the trigger sweep. Job ids
 * are deterministic (`flow_<runId>_<seq>`), so scheduling the same wake-up
 * twice is a no-op. Without REDIS_URL (unit tests, scripts) scheduling is a
 * no-op and only the sweep wakes runs.
 *
 * FLOWS_DISABLED=1 is the kill switch (see config.ts).
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { isFlowsEnabled } from "./config";

export { isFlowsEnabled } from "./config";

export const FLOWS_QUEUE_NAME = "flows";
export const FLOW_RESUME_JOB = "flow-resume";
export const FLOW_RUN_STEP_JOB = "flow-run-step";

export interface FlowJob {
  runId: string;
  /** The run's seq when the job was scheduled; a moved run makes the job a no-op. */
  expectedSeq?: number;
}

let queue: Queue<FlowJob> | null = null;

export function getFlowsQueue(): Queue<FlowJob> {
  if (!queue) {
    queue = new Queue<FlowJob>(FLOWS_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
      },
    });
  }
  return queue;
}

export function hasFlowsQueueBackend(): boolean {
  return isFlowsEnabled() && Boolean(process.env.REDIS_URL?.trim());
}

/** BullMQ forbids ":" in custom job ids. */
function safeId(value: string): string {
  return value.replace(/:/g, "_");
}

/** Delayed wake-up of a waiting run. Never throws into the caller's flow: the sweep is the safety net. */
export async function scheduleFlowResume(runId: string, seq: number, at: Date): Promise<void> {
  if (!hasFlowsQueueBackend()) return;
  await getFlowsQueue().add(
    FLOW_RESUME_JOB,
    { runId, expectedSeq: seq },
    { jobId: safeId(`flow_${runId}_${seq}`), delay: Math.max(0, at.getTime() - Date.now()) }
  );
}

/** Continue an ACTIVE run now (used by the sweep). */
export async function enqueueFlowStep(runId: string, seq: number, suffix?: string): Promise<void> {
  if (!hasFlowsQueueBackend()) return;
  await getFlowsQueue().add(
    FLOW_RUN_STEP_JOB,
    { runId, expectedSeq: seq },
    { jobId: safeId(suffix ? `flowstep_${runId}_${seq}_${suffix}` : `flowstep_${runId}_${seq}`) }
  );
}
