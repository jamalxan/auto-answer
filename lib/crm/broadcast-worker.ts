/**
 * Plugs the broadcast engine into the CRM worker (lib/crm/worker.ts): the two
 * job handlers on the shared "crm" queue and the minute maintenance task.
 * Called once from worker/dm-worker.ts when the CRM worker starts; a no-op
 * without CRM_ENABLED=1 (or with CRM_DISABLED=1): the worker is not created at all.
 */

import type { Job } from "bullmq";
import { registerBroadcastListeners, runBroadcastBatch, runBroadcastMaintenance, startBroadcast } from "./broadcast";
import { BROADCAST_BATCH_JOB, BROADCAST_START_JOB, type BroadcastJob } from "./broadcast-queue";
import type { CrmJob } from "./queue";
import { registerCrmJobHandler, registerCrmMaintenanceTask } from "./worker";

export { runBroadcastMaintenance };

export async function processBroadcastJob(job: Pick<Job<CrmJob>, "name" | "data">): Promise<unknown> {
  const data = job.data as unknown as BroadcastJob;
  if (!data?.broadcastId) return { skipped: "no broadcastId" };
  if (job.name === BROADCAST_START_JOB) return startBroadcast(data.broadcastId);
  if (job.name === BROADCAST_BATCH_JOB) return runBroadcastBatch(data.broadcastId, new Date(), data.tickSeq ?? null);
  return null;
}

let registered = false;

/** Idempotent registration of handlers, the maintenance task and the attribution listeners. */
export function registerBroadcastModule(): void {
  if (registered) return;
  registered = true;
  registerBroadcastListeners();
  registerCrmJobHandler(BROADCAST_START_JOB, processBroadcastJob);
  registerCrmJobHandler(BROADCAST_BATCH_JOB, processBroadcastJob);
  registerCrmMaintenanceTask("broadcast", async () => {
    const out = await runBroadcastMaintenance();
    if (out.started || out.requeued) console.log("[CRM Broadcast] maintenance:", JSON.stringify(out));
  });
}
