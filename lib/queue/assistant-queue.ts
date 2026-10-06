/**
 * Queue for the lead assistant: reply jobs (debounced), lead deliveries to
 * Telegram / amoCRM / Bitrix24, owner notifications. A separate queue from the
 * campaign DM queue so a CRM outage can never delay campaign DMs.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "./client";

export const ASSISTANT_QUEUE_NAME = "lead-assistant";

export const REPLY_JOB = "assistant-reply";
export const DELIVER_JOB = "lead-deliver";
export const NOTIFY_JOB = "owner-notify";
export const INBOUND_JOB = "assistant-inbound";
export const ECHO_JOB = "assistant-echo";

export interface ReplyJob {
  conversationId: string;
}

export interface DeliverJob {
  deliveryId: string;
}

export interface NotifyJob {
  kind: "customer_wrote_again" | "gap_digest" | "price_reminder" | "onboarding_reminder";
  workspaceId?: string;
  conversationId?: string;
}

/** A customer DM (webhook messages event) for the assistant. */
export interface InboundJob {
  instagramAccountId: string; // Instagram professional id (webhook entry.id)
  senderId: string;
  messageId: string;
  text: string;
  hasAttachment: boolean;
}

/** An echo: a message the account itself sent (human operator or our app). */
export interface EchoJob {
  instagramAccountId: string;
  customerId: string;
  messageId: string;
  text: string;
  appId?: string | null;
}

export type AssistantJob = ReplyJob | DeliverJob | NotifyJob | InboundJob | EchoJob;

let queue: Queue<AssistantJob> | null = null;

export function getAssistantQueue(): Queue<AssistantJob> {
  if (!queue) {
    queue = new Queue<AssistantJob>(ASSISTANT_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { age: 3600, count: 1000 },
        attempts: 1, // retries are managed explicitly (DB backoff schedule)
      },
    });
  }
  return queue;
}

/** BullMQ forbids ":" in custom job ids. */
function safeId(value: string): string {
  return value.replace(/:/g, "_");
}

export async function enqueueDelivery(deliveryId: string, delayMs = 0) {
  await getAssistantQueue().add(
    DELIVER_JOB,
    { deliveryId },
    {
      delay: delayMs,
      // Unique per schedule so a retry is never swallowed by a completed job.
      jobId: safeId(`deliver_${deliveryId}_${Date.now()}`),
    }
  );
}

/**
 * Debounced reply: each new customer message replaces the pending job, so a
 * burst of messages gets exactly one answer, `delayMs` after the last one.
 */
export async function scheduleReply(conversationId: string, delayMs: number) {
  const q = getAssistantQueue();
  const jobId = safeId(`reply_${conversationId}`);
  const existing = await q.getJob(jobId);
  let id = jobId;
  if (existing) {
    const state = await existing.getState();
    if (state === "active") {
      // The worker is mid-reply: schedule a fresh job for the new message.
      id = safeId(`reply_${conversationId}_${Date.now()}`);
    } else {
      await existing.remove().catch(() => {});
    }
  }
  await q.add(REPLY_JOB, { conversationId }, { delay: delayMs, jobId: id });
}

export async function enqueueNotify(job: NotifyJob, delayMs = 0, jobId?: string) {
  await getAssistantQueue().add(NOTIFY_JOB, job, {
    delay: delayMs,
    jobId: jobId ? safeId(jobId) : undefined,
  });
}

export async function enqueueInbound(job: InboundJob) {
  await getAssistantQueue().add(INBOUND_JOB, job, {
    jobId: safeId(`inbound_${job.instagramAccountId}_${Buffer.from(job.messageId).toString("base64url")}`),
  });
}

/** Echoes are delayed so our own send has time to store its message id first. */
export async function enqueueEcho(job: EchoJob) {
  await getAssistantQueue().add(ECHO_JOB, job, {
    delay: 3000,
    jobId: safeId(`echo_${job.instagramAccountId}_${Buffer.from(job.messageId).toString("base64url")}`),
  });
}
