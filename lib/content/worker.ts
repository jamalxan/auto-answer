/**
 * ETAP 13 — the two content workers, registered in worker/dm-worker.ts next
 * to the others (not created with CONTENT_SCHEDULER_DISABLED=1).
 *
 *   content-publish  concurrency 5: a step is a few DB reads, one or two Meta
 *                    calls and a status wait; the per-account Redis lock in
 *                    publish.ts keeps one account's posts serial.
 *   media-process    concurrency 1: ffmpeg must not compete with itself on a
 *                    single server (spec §15).
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { isContentSchedulerEnabled } from "./config";
import { processMedia } from "./media-process";
import {
  CONTENT_PUBLISH_QUEUE,
  FIRST_COMMENT_JOB,
  MANUAL_NOTIFY_JOB,
  MEDIA_PROCESS_QUEUE,
  PREPARE_JOB,
  PUBLISH_JOB,
  type MediaProcessJob,
  type PublishJob,
} from "./queue";

export { isContentSchedulerEnabled } from "./config";

export interface ContentWorkers {
  publish: Worker<PublishJob>;
  media: Worker<MediaProcessJob>;
  close(): Promise<void>;
}

async function processPublishJob(job: Job<PublishJob>): Promise<unknown> {
  if (!isContentSchedulerEnabled()) return { skipped: "CONTENT_SCHEDULER_DISABLED" };
  // Imported lazily: the pipeline pulls the Meta client and Telegram, which
  // the media worker never needs.
  const pipeline = await import("./publish");
  switch (job.name) {
    case PREPARE_JOB:
      return pipeline.preparePost(job.data.postId, job.data.attempt);
    case PUBLISH_JOB:
      return pipeline.publishPost(job.data.postId, job.data.attempt);
    case FIRST_COMMENT_JOB:
      return pipeline.postFirstComment(job.data.postId);
    case MANUAL_NOTIFY_JOB: {
      const manual = await import("./manual");
      return manual.sendManualNotice(job.data.postId);
    }
    default:
      return { skipped: `unknown job ${job.name}` };
  }
}

export function createContentWorkers(): ContentWorkers {
  const connection = getRedisConnection();
  const publish = new Worker<PublishJob>(CONTENT_PUBLISH_QUEUE, processPublishJob, { connection, concurrency: 5 });
  publish.on("failed", (job, err) => console.error(`[Content] job ${job?.id} failed:`, err.stack ?? err.message));
  publish.on("error", (err) => console.error("[Content] publish worker error:", err.message));

  const media = new Worker<MediaProcessJob>(
    MEDIA_PROCESS_QUEUE,
    async (job) => {
      if (!isContentSchedulerEnabled()) return { skipped: "CONTENT_SCHEDULER_DISABLED" };
      await processMedia(job.data.mediaId);
      return { processed: job.data.mediaId };
    },
    { connection, concurrency: 1, lockDuration: 15 * 60_000 }
  );
  media.on("failed", (job, err) => console.error(`[Content] media job ${job?.id} failed:`, err.stack ?? err.message));
  media.on("error", (err) => console.error("[Content] media worker error:", err.message));

  return {
    publish,
    media,
    async close() {
      await Promise.all([publish.close(), media.close()]);
    },
  };
}

let lastSweepAt = 0;

/** Every minute from the worker process: the sweeper (lost jobs, late posts, manual notices). */
export async function runContentMaintenance(): Promise<void> {
  if (!isContentSchedulerEnabled()) return;
  if (Date.now() - lastSweepAt < 55_000) return;
  lastSweepAt = Date.now();
  try {
    const { sweepContent } = await import("./sweep");
    const result = await sweepContent();
    const touched = Object.values(result).reduce((sum, n) => sum + n, 0);
    if (touched > 0) console.log("[Content] sweep:", JSON.stringify(result));
  } catch (error) {
    console.error("[Content] sweep failed:", error instanceof Error ? error.message : error);
  }
}
