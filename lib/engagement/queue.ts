/**
 * ETAP 9 — the engagement BullMQ queue ("engagement"), separate from every
 * other queue so a giveaway backfill can never hold up a reply or a delivery.
 *
 *   giveaway-backfill  scan the post's comments into entries
 *   giveaway-notify    announce the winners of a CONFIRMED draw
 *   referral-reward    reward a qualified referral (handler registered by lib/engagement/referral)
 */

import { Queue, type JobsOptions } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { isEngagementEnabled } from "./config";

export const ENGAGEMENT_QUEUE_NAME = "engagement";

export const GIVEAWAY_BACKFILL_JOB = "giveaway-backfill";
export const GIVEAWAY_NOTIFY_JOB = "giveaway-notify";
export const REFERRAL_REWARD_JOB = "referral-reward";

export interface GiveawayBackfillJob {
  workspaceId: string;
  giveawayId: string;
}

export interface GiveawayNotifyJob {
  workspaceId: string;
  giveawayId: string;
  sequence: number;
}

export type EngagementJob = GiveawayBackfillJob | GiveawayNotifyJob | Record<string, unknown>;

let queue: Queue<EngagementJob> | null = null;

export function getEngagementQueue(): Queue<EngagementJob> {
  if (!queue) {
    queue = new Queue<EngagementJob>(ENGAGEMENT_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { age: 24 * 3600, count: 500 },
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
      },
    });
  }
  return queue;
}

/** BullMQ forbids ":" in custom job ids. */
export function safeJobId(value: string): string {
  return value.replace(/:/g, "_");
}

/**
 * Hand one job to the worker. Returns false (nothing queued) when the kill
 * switch is on or Redis is not configured (unit tests, one-off scripts).
 */
export async function enqueueEngagement(name: string, data: EngagementJob, opts: JobsOptions = {}): Promise<boolean> {
  if (!isEngagementEnabled()) return false;
  if (!process.env.REDIS_URL?.trim()) return false;
  await getEngagementQueue().add(name, data, opts);
  return true;
}
