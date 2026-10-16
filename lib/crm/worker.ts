/**
 * The "crm" queue's worker. Registered in worker/dm-worker.ts next to the
 * trigger and JavobAI workers, with the same shutdown pattern; not started
 * at all without CRM_ENABLED=1 (or with CRM_DISABLED=1). Concurrency 2: a touch is a handful of
 * indexed reads and one upsert, and the reconciler runs in the maintenance
 * tick, so more workers would only race the same contact rows.
 *
 * Other CRM modules add their own jobs and periodic work without editing
 * this file: `registerCrmJobHandler("crm-broadcast-tick", fn)` and
 * `registerCrmMaintenanceTask("broadcast", fn)`.
 */

import { Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { runBackfill } from "./backfill";
import { CRM_RECONCILE_INTERVAL_MS } from "./defaults";
import {
  CRM_BACKFILL_JOB,
  CRM_QUEUE_NAME,
  CRM_RECONCILE_JOB,
  CRM_TOUCH_JOB,
  isCrmEnabled,
  type CrmBackfillJob,
  type CrmJob,
  type CrmReconcileJob,
  type CrmTouchJob,
} from "./queue";
import { RECONCILE_SOURCES, applyCrmTouch, runCrmReconcile, type ReconcileSource } from "./sync";
// The tag and assignment listeners register themselves on import (5.1 / 5.3):
// loading them here wires them into the worker process, where the events fire.
import "./assignment";
import "./tags";

export { isCrmEnabled } from "./queue";

type JobHandler = (job: Job<CrmJob>) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

/** Add a job name to the worker (the registering module owns the job's data shape). */
export function registerCrmJobHandler(name: string, handler: JobHandler): () => void {
  handlers.set(name, handler);
  return () => void handlers.delete(name);
}

type MaintenanceTask = () => Promise<void>;

const maintenanceTasks = new Map<string, MaintenanceTask>();

/** Run on every maintenance tick (once a minute from the worker process); the task throttles itself. */
export function registerCrmMaintenanceTask(name: string, task: MaintenanceTask): () => void {
  maintenanceTasks.set(name, task);
  return () => void maintenanceTasks.delete(name);
}

async function processJob(job: Job<CrmJob>): Promise<unknown> {
  if (!isCrmEnabled()) return { skipped: "CRM_DISABLED" };
  if (job.name === CRM_TOUCH_JOB) return applyCrmTouch(job.data as CrmTouchJob);
  if (job.name === CRM_RECONCILE_JOB) {
    const source = (job.data as CrmReconcileJob).source as ReconcileSource | null | undefined;
    const sources = source && (RECONCILE_SOURCES as readonly string[]).includes(source) ? [source] : undefined;
    return runCrmReconcile({ sources });
  }
  if (job.name === CRM_BACKFILL_JOB) return runBackfill((job.data as CrmBackfillJob).workspaceId ?? null);
  const handler = handlers.get(job.name);
  if (handler) return handler(job);
  console.warn(`[CRM Worker] no handler for job ${job.name}`);
  return { skipped: "unknown job" };
}

export function createCrmWorker(): Worker<CrmJob> {
  const worker = new Worker<CrmJob>(CRM_QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency: 2,
  });

  worker.on("failed", (job, err) => {
    console.error(`[CRM Worker] job ${job?.id} (${job?.name}) failed:`, err.stack ?? err.message);
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `CRM job ${job?.name ?? "?"} failed: ${err.message}`.slice(0, 500),
          payload: { jobId: job?.id ?? null },
        },
      })
      .catch(() => {});
  });

  worker.on("error", (err) => {
    console.error("[CRM Worker] error:", err.message);
  });

  return worker;
}

let lastReconcileAt = 0;
let reconciling = false;

/**
 * Called once a minute from worker/dm-worker.ts. The reconciler runs every
 * CRM_RECONCILE_INTERVAL_MS (5 min); registered tasks run every tick.
 */
export async function runCrmMaintenance(options: { force?: boolean; now?: Date } = {}): Promise<void> {
  if (!isCrmEnabled()) return;
  const now = options.now?.getTime() ?? Date.now();
  if ((options.force || now - lastReconcileAt >= CRM_RECONCILE_INTERVAL_MS) && !reconciling) {
    reconciling = true;
    lastReconcileAt = now;
    try {
      const counts = await runCrmReconcile({ now: new Date(now) });
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      if (total > 0) console.log("[CRM] reconcile:", JSON.stringify(counts));
    } catch (error) {
      console.error("[CRM] reconcile failed:", error instanceof Error ? error.message : error);
    } finally {
      reconciling = false;
    }
  }
  for (const [name, task] of maintenanceTasks) {
    try {
      await task();
    } catch (error) {
      console.error(`[CRM] maintenance task ${name} failed:`, error instanceof Error ? error.message : error);
    }
  }
}

/** Tests: forget the throttle so the next call reconciles. */
export function resetCrmMaintenanceForTests(): void {
  lastReconcileAt = 0;
  reconciling = false;
}
