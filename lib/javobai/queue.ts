/**
 * JavobAI's own BullMQ queue — separate from "lead-assistant", so a slow
 * model or a bug here can never delay production's replies or deliveries.
 *
 *   inbound  a customer DM the gate routed here (LIVE) or copied here (SHADOW)
 *   reply    the debounced answer of one conversation (LIVE only)
 *   echo     the account itself sent a message (operator takes the handoff)
 *
 * Job ids mirror the production queue's so a redelivered webhook is a no-op,
 * and the reply job is debounced the same way (one answer per burst).
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import type { EchoJob, InboundJob } from "@/lib/queue/assistant-queue";

export const JAVOBAI_QUEUE_NAME = "javobai";

export const JAVOBAI_INBOUND_JOB = "javobai-inbound";
export const JAVOBAI_REPLY_JOB = "javobai-reply";
export const JAVOBAI_ECHO_JOB = "javobai-echo";

/**
 * SHADOW turns wait this long so production's reply (if any) is already in
 * the conversation record when the comparison is stored.
 */
export const SHADOW_DELAY_MS = 20_000;

export interface JavobAiInboundJob extends InboundJob {
  /** True: compute and log only (SHADOW); false: answer (LIVE). */
  shadow: boolean;
  /** Where the message came from; "trigger" = the AI quick-reply action. */
  source?: "webhook" | "trigger";
}

export interface JavobAiReplyJob {
  conversationId: string;
}

export type JavobAiEchoJob = EchoJob;

export type JavobAiJob = JavobAiInboundJob | JavobAiReplyJob | JavobAiEchoJob;

let queue: Queue<JavobAiJob> | null = null;

export function getJavobAiQueue(): Queue<JavobAiJob> {
  if (!queue) {
    queue = new Queue<JavobAiJob>(JAVOBAI_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { age: 3600, count: 1000 },
        attempts: 1, // a failed turn is answered on the next customer message
      },
    });
  }
  return queue;
}

/** BullMQ forbids ":" in custom job ids. */
function safeId(value: string): string {
  return value.replace(/:/g, "_");
}

function midKey(job: { instagramAccountId: string; messageId: string }): string {
  return `${job.instagramAccountId}_${Buffer.from(job.messageId).toString("base64url")}`;
}

export async function enqueueJavobAiInbound(job: JavobAiInboundJob) {
  await getJavobAiQueue().add(JAVOBAI_INBOUND_JOB, job, {
    delay: job.shadow ? SHADOW_DELAY_MS : 0,
    jobId: safeId(`jai_in_${job.shadow ? "shadow_" : ""}${midKey(job)}`),
  });
}

/** Same debounce as production's scheduleReply: a burst gets one answer. */
export async function scheduleJavobAiReply(conversationId: string, delayMs: number) {
  const q = getJavobAiQueue();
  const jobId = safeId(`jai_reply_${conversationId}`);
  const existing = await q.getJob(jobId);
  let id = jobId;
  if (existing) {
    const state = await existing.getState();
    if (state === "active") {
      id = safeId(`jai_reply_${conversationId}_${Date.now()}`);
    } else {
      await existing.remove().catch(() => {});
    }
  }
  await q.add(JAVOBAI_REPLY_JOB, { conversationId }, { delay: delayMs, jobId: id });
}

/** Delayed like production's echo so our own send has stored its mid first. */
export async function enqueueJavobAiEcho(job: JavobAiEchoJob) {
  await getJavobAiQueue().add(JAVOBAI_ECHO_JOB, job, {
    delay: 3000,
    jobId: safeId(`jai_echo_${midKey(job)}`),
  });
}
