/**
 * ETAP 5.0 — the CRM's own BullMQ queue ("crm"), separate from
 * "dm-processing", "lead-assistant", "instagram-triggers" and "javobai" so a
 * CRM problem can never hold up a reply or a delivery.
 *
 *   crm-touch      one fire-and-forget hook from the engines (lib/crm/hooks.ts)
 *   crm-reconcile  run the cursor reconciler now (the worker also runs it every 5 min)
 *   crm-backfill   one-off import of the four stores into CrmContact (design §1)
 *
 * Other CRM modules (broadcast delivery) add their own job names through
 * `registerCrmJobHandler` in lib/crm/worker.ts.
 *
 * Opt-in: nothing runs unless `CRM_ENABLED=1` (developer area only until
 * promotion). Kill switch `CRM_DISABLED=1` wins over it: no hooks, no worker,
 * no reconciler, no broadcast.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";

export const CRM_QUEUE_NAME = "crm";

export const CRM_TOUCH_JOB = "crm-touch";
export const CRM_RECONCILE_JOB = "crm-reconcile";
export const CRM_BACKFILL_JOB = "crm-backfill";

function envFlag(name: string): boolean {
  const flag = (process.env[name] ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

/**
 * The CRM is opt-in: hooks, worker, reconciler and broadcast run only with
 * `CRM_ENABLED=1`, and `CRM_DISABLED=1` switches them off even then. Without
 * either flag production is untouched.
 */
export function isCrmEnabled(): boolean {
  return envFlag("CRM_ENABLED") && !envFlag("CRM_DISABLED");
}

/**
 * The hooks need Redis to hand a job over. Without `REDIS_URL` (unit tests,
 * one-off scripts) they are a no-op; the reconciler still covers everything.
 */
export function hasCrmQueueBackend(): boolean {
  return isCrmEnabled() && Boolean(process.env.REDIS_URL?.trim());
}

export type CrmTouchKind =
  | "inbound"
  | "operator_reply"
  | "ai_reply"
  | "automation_reply"
  | "lead_created"
  | "lead_contacted"
  | "handoff"
  | "score"
  | "trigger_interaction";

/**
 * What an engine knows at the moment it fires the hook. Any one of
 * conversationId / instagramContactId / leadId / aiStateId / (workspaceId +
 * instagramAccountId + igUserId) is enough: the worker resolves the rest.
 */
export interface CrmTouchInput {
  kind: CrmTouchKind;
  conversationId?: string | null;
  instagramContactId?: string | null;
  leadId?: string | null;
  /** AiConversationState id (the score hook only knows the state). */
  aiStateId?: string | null;
  workspaceId?: string | null;
  instagramAccountId?: string | null;
  igUserId?: string | null;
  /** The operator's User id when known (inbox reply, Telegram button). */
  userId?: string | null;
  /** When it happened; now when omitted. Serialised as ISO text in the job. */
  at?: Date | string | null;
  payload?: Record<string, unknown> | null;
}

export type CrmTouchJob = CrmTouchInput;

export interface CrmReconcileJob {
  /** Reconcile only this source (see lib/crm/sync.ts RECONCILE_SOURCES); all when omitted. */
  source?: string | null;
}

export interface CrmBackfillJob {
  /** One workspace, or every workspace when omitted. */
  workspaceId?: string | null;
  requestedBy?: string | null;
}

export type CrmJob = CrmTouchJob | CrmReconcileJob | CrmBackfillJob;

let queue: Queue<CrmJob> | null = null;

export function getCrmQueue(): Queue<CrmJob> {
  if (!queue) {
    queue = new Queue<CrmJob>(CRM_QUEUE_NAME, {
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

/** BullMQ forbids ":" in custom job ids. */
function safeId(value: string): string {
  return value.replace(/:/g, "_");
}

export async function enqueueCrmTouch(job: CrmTouchJob): Promise<void> {
  const at = job.at instanceof Date ? job.at.toISOString() : (job.at ?? null);
  await getCrmQueue().add(CRM_TOUCH_JOB, { ...job, at });
}

/** One pending reconcile at a time: a second request while one waits is a no-op. */
export async function enqueueCrmReconcile(job: CrmReconcileJob = {}): Promise<void> {
  await getCrmQueue().add(CRM_RECONCILE_JOB, job, {
    jobId: safeId(`crm-reconcile_${job.source ?? "all"}`),
    attempts: 1,
  });
}

export async function enqueueCrmBackfill(job: CrmBackfillJob = {}): Promise<void> {
  await getCrmQueue().add(CRM_BACKFILL_JOB, job, {
    jobId: safeId(`crm-backfill_${job.workspaceId ?? "all"}_${Date.now()}`),
    attempts: 1,
  });
}
