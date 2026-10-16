/**
 * ETAP 8 — the bus's own BullMQ queue ("integrations"), separate from
 * "crm", "dm-processing" and "lead-assistant": a dead webhook receiver can
 * never hold up a reply or a lead card.
 *
 *   integrations-materialize  freeze the payload of an OutboundEvent, create deliveries
 *   integrations-deliver      send one OutboundDelivery
 *
 * Job ids are deterministic (no ":"): the n-th attempt of a delivery is
 * `ob_deliver_<id>_<n>`, so a retry is never swallowed by a completed job
 * and the maintenance sweep re-enqueueing a lost one is a no-op while it
 * still exists. `attempts: 1`: the retry schedule lives in Postgres.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { isOutboundBusEnabled } from "./config";

export const INTEGRATIONS_QUEUE_NAME = "integrations";
export const MATERIALIZE_JOB = "integrations-materialize";
export const DELIVER_JOB = "integrations-deliver";

export interface MaterializeJob {
  eventId: string;
}

export interface DeliverJob {
  deliveryId: string;
}

export type IntegrationsJob = MaterializeJob | DeliverJob;

/** Redis is needed to hand a job over; unit tests and one-off scripts run without it. */
export function hasIntegrationsQueueBackend(): boolean {
  return isOutboundBusEnabled() && Boolean(process.env.REDIS_URL?.trim());
}

let queue: Queue<IntegrationsJob> | null = null;

export function getIntegrationsQueue(): Queue<IntegrationsJob> {
  if (!queue) {
    queue = new Queue<IntegrationsJob>(INTEGRATIONS_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
        attempts: 1,
      },
    });
  }
  return queue;
}

/** BullMQ forbids ":" in custom job ids. */
function safeId(value: string): string {
  return value.replace(/:/g, "_");
}

export async function enqueueMaterialize(eventId: string, delayMs = 0): Promise<void> {
  if (!hasIntegrationsQueueBackend()) return;
  await getIntegrationsQueue().add(
    MATERIALIZE_JOB,
    { eventId },
    { delay: Math.max(0, delayMs), jobId: safeId(`ob_materialize_${eventId}`) }
  );
}

/** `attempt` keys the job: the n-th attempt of a delivery is one job however often it is enqueued. */
export async function enqueueOutboundDelivery(deliveryId: string, delayMs = 0, attempt: number | string = 0): Promise<void> {
  if (!hasIntegrationsQueueBackend()) return;
  await getIntegrationsQueue().add(
    DELIVER_JOB,
    { deliveryId },
    { delay: Math.max(0, delayMs), jobId: safeId(`ob_deliver_${deliveryId}_${attempt}`) }
  );
}
