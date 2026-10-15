/**
 * The "javobai" queue's worker. Registered in worker/dm-worker.ts next to the
 * trigger worker, with the same shutdown pattern; not started at all when
 * JAVOBAI_DISABLED=1. Concurrency 3: a reply holds the conversation lock, so
 * more workers only help across conversations, and the model is the slow part.
 */

import { Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import {
  JAVOBAI_ECHO_JOB,
  JAVOBAI_INBOUND_JOB,
  JAVOBAI_QUEUE_NAME,
  JAVOBAI_REPLY_JOB,
  type JavobAiEchoJob,
  type JavobAiInboundJob,
  type JavobAiJob,
  type JavobAiReplyJob,
} from "./queue";
import { handleJavobAiEcho, handleJavobAiInbound, runJavobAiReply } from "./runtime";

export { runJavobAiMaintenance } from "./runtime";

async function processJob(job: Job<JavobAiJob>): Promise<void> {
  if (job.name === JAVOBAI_INBOUND_JOB) return handleJavobAiInbound((job as Job<JavobAiInboundJob>).data);
  if (job.name === JAVOBAI_REPLY_JOB) return runJavobAiReply((job as Job<JavobAiReplyJob>).data.conversationId);
  if (job.name === JAVOBAI_ECHO_JOB) return handleJavobAiEcho((job as Job<JavobAiEchoJob>).data);
}

export function createJavobAiWorker(): Worker<JavobAiJob> {
  const worker = new Worker<JavobAiJob>(JAVOBAI_QUEUE_NAME, processJob, {
    connection: getRedisConnection(),
    concurrency: 3,
  });

  worker.on("failed", (job, err) => {
    console.error(`[JavobAI Worker] job ${job?.id} (${job?.name}) failed:`, err.stack ?? err.message);
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `JavobAI job ${job?.name ?? "?"} failed: ${err.message}`.slice(0, 500),
          payload: { jobId: job?.id ?? null },
        },
      })
      .catch(() => {});
  });

  worker.on("error", (err) => {
    console.error("[JavobAI Worker] error:", err.message);
  });

  return worker;
}
