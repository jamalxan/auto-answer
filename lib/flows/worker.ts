/**
 * ETAP 6 — the "flows" queue worker and the 60s maintenance tick, registered
 * in worker/dm-worker.ts next to the trigger / JavobAI / CRM workers (not
 * started with FLOWS_DISABLED=1). Concurrency 3: a step is a few indexed
 * reads, one CAS update and at most one Meta call, and two jobs for one run
 * are serialised by the run's compare-and-swap anyway.
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { continueFlowRun, resumeFlowRun, runDueFlowRuns, sweepFlowRuns } from "./engine";
import { FLOW_RESUME_JOB, FLOW_RUN_STEP_JOB, FLOWS_QUEUE_NAME, isFlowsEnabled, type FlowJob } from "./queue";

export { isFlowsEnabled } from "./queue";

export function createFlowsWorker(): Worker<FlowJob> {
  const worker = new Worker<FlowJob>(
    FLOWS_QUEUE_NAME,
    async (job: Job<FlowJob>) => {
      if (!isFlowsEnabled()) return { skipped: "FLOWS_DISABLED" };
      if (job.name === FLOW_RESUME_JOB) {
        return resumeFlowRun(job.data.runId, { kind: "timer" }, { expectedSeq: job.data.expectedSeq });
      }
      if (job.name === FLOW_RUN_STEP_JOB) return continueFlowRun(job.data.runId);
      return { skipped: `unknown job ${job.name}` };
    },
    { connection: getRedisConnection(), concurrency: 3 }
  );
  worker.on("failed", (job, err) => console.error(`[Flows] job ${job?.id} failed:`, err.stack ?? err.message));
  worker.on("error", (err) => console.error("[Flows] worker error:", err.message));
  return worker;
}

/**
 * Every minute from the worker process:
 *   1. WAITING runs whose time has come (Delay, button timeout, send retry) → resume;
 *   2. sweep: stuck ACTIVE runs (resume once, then FAILED), runs older than 7 days,
 *      runs of unpublished / archived flows → CANCELLED, retention of old finished runs.
 */
export async function runFlowsMaintenance(): Promise<void> {
  if (!isFlowsEnabled()) return;
  try {
    const due = await runDueFlowRuns();
    if (due.resumed > 0) console.log(`[Flows] resumed ${due.resumed} due run(s)`);
  } catch (error) {
    console.error("[Flows] due-run sweep failed:", error instanceof Error ? error.message : error);
  }
  try {
    const swept = await sweepFlowRuns();
    const touched = Object.values(swept).reduce((sum, n) => sum + n, 0);
    if (touched > 0) console.log("[Flows] sweep:", JSON.stringify(swept));
  } catch (error) {
    console.error("[Flows] sweep failed:", error instanceof Error ? error.message : error);
  }
}
