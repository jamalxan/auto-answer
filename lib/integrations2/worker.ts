/**
 * ETAP 8 — the "integrations" queue's worker and its maintenance tick.
 * Registered in worker/dm-worker.ts next to the CRM / JavobAI workers with
 * the same shutdown pattern; not started with `INTEGRATIONS_BUS_DISABLED=1`.
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { isOutboundBusEnabled } from "./config";
import { registerIntegrationsCrmListeners } from "./crm-listener";
import { purgeOldOutbound, processOutboundDelivery, sweepDueOutbound, sweepUnmaterialized } from "./deliver";
import { materializeEvent } from "./materialize";
import {
  DELIVER_JOB,
  INTEGRATIONS_QUEUE_NAME,
  MATERIALIZE_JOB,
  type DeliverJob,
  type IntegrationsJob,
  type MaterializeJob,
} from "./queue";

export { isOutboundBusEnabled } from "./config";

export async function processIntegrationsJob(job: Pick<Job<IntegrationsJob>, "name" | "data">): Promise<unknown> {
  if (!isOutboundBusEnabled()) return { skipped: "INTEGRATIONS_BUS_DISABLED" };
  if (job.name === MATERIALIZE_JOB) return materializeEvent((job.data as MaterializeJob).eventId);
  if (job.name === DELIVER_JOB) return processOutboundDelivery((job.data as DeliverJob).deliveryId);
  return null;
}

/** Idempotent: the CRM listeners (becameHot → lead.hot, stage_changed → deal.stage_changed). */
export function registerIntegrationsModule(): void {
  registerIntegrationsCrmListeners();
}

export function createIntegrationsWorker(): Worker<IntegrationsJob> {
  registerIntegrationsModule();
  const worker = new Worker<IntegrationsJob>(INTEGRATIONS_QUEUE_NAME, (job) => processIntegrationsJob(job), {
    connection: getRedisConnection(),
    concurrency: 4,
  });
  worker.on("failed", (job, error) => {
    console.error(`[Integrations] job ${job?.name} failed:`, error.message);
  });
  return worker;
}

export interface MaintenanceReport {
  due: number;
  unmaterialized: number;
  purged: number;
}

let lastPurgeAt = 0;
const PURGE_EVERY_MS = 60 * 60_000;

/** Every tick (once a minute): due deliveries (also expired leases), lost materialise jobs, hourly retention. */
export async function runIntegrationsMaintenance(now = new Date()): Promise<MaintenanceReport> {
  const report: MaintenanceReport = { due: 0, unmaterialized: 0, purged: 0 };
  if (!isOutboundBusEnabled()) return report;
  try {
    report.due = await sweepDueOutbound(200, now);
    report.unmaterialized = await sweepUnmaterialized(50, now);
    if (now.getTime() - lastPurgeAt >= PURGE_EVERY_MS) {
      lastPurgeAt = now.getTime();
      report.purged = await purgeOldOutbound(now);
    }
    if (report.due || report.unmaterialized || report.purged) {
      console.log("[Integrations] maintenance:", JSON.stringify(report));
    }
  } catch (error) {
    console.error("[Integrations] maintenance failed:", error instanceof Error ? error.message : error);
  }
  return report;
}

export function resetIntegrationsMaintenanceForTests(): void {
  lastPurgeAt = 0;
}
