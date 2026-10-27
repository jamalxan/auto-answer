/**
 * ETAP 13 — the two content workers, registered in worker/dm-worker.ts next
 * to the others (not created with CONTENT_SCHEDULER_DISABLED=1).
 *
 *   content-publish  concurrency 5: a step is a few DB reads, one or two Meta
 *                    calls and a status wait; the per-account Redis lock in
 *                    publish.ts keeps one account's posts serial.
 *   media-process    concurrency 1: ffmpeg must not compete with itself on a
 *                    single server (spec §15). Videos only.
 *   media-image      concurrency 3: sharp work of a few hundred ms per photo, so a
 *                    batch of photos is ready while a video still transcodes.
 */

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { isContentSchedulerEnabled } from "./config";
import { processMedia } from "./media-process";
import {
  CONTENT_PUBLISH_QUEUE,
  FIRST_COMMENT_JOB,
  MANUAL_NOTIFY_JOB,
  MEDIA_IMAGE_QUEUE,
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
  image: Worker<MediaProcessJob>;
  close(): Promise<void>;
}

async function processPublishJob(job: Job<PublishJob>): Promise<unknown> {
  if (!isContentSchedulerEnabled()) return { skipped: "CONTENT_SCHEDULER_DISABLED" };
  // Imported lazily: the pipeline pulls the Meta client and Telegram, which
  // the media worker never needs.
  const pipeline = await import("./publish");
  switch (job.name) {
    case PREPARE_JOB:
      return pipeline.preparePost(job.data.postId, job.data.attempt, {}, job.data.retryNo ?? 0);
    case PUBLISH_JOB:
      return pipeline.publishPost(job.data.postId, job.data.attempt, {}, job.data.retryNo ?? 0);
    case FIRST_COMMENT_JOB:
      return pipeline.postFirstComment(job.data.postId, {}, job.data.retryNo ?? 0);
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

  const processJob = async (job: Job<MediaProcessJob>) => {
    if (!isContentSchedulerEnabled()) return { skipped: "CONTENT_SCHEDULER_DISABLED" };
    await processMedia(job.data.mediaId);
    return { processed: job.data.mediaId };
  };
  const media = new Worker<MediaProcessJob>(MEDIA_PROCESS_QUEUE, processJob, { connection, concurrency: 1, lockDuration: 15 * 60_000 });
  const image = new Worker<MediaProcessJob>(MEDIA_IMAGE_QUEUE, processJob, { connection, concurrency: 3, lockDuration: 2 * 60_000 });
  for (const [name, worker] of [["media", media], ["image", image]] as const) {
    worker.on("failed", (job, err) => console.error(`[Content] ${name} job ${job?.id} failed:`, err.stack ?? err.message));
    worker.on("error", (err) => console.error(`[Content] ${name} worker error:`, err.message));
  }

  return {
    publish,
    media,
    image,
    async close() {
      await Promise.all([publish.close(), media.close(), image.close()]);
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
  runContentIntel();
}

let intelRunning = false;

/** Content intelligence (audit phase 5) runs beside the sweep: a slow video analysis never delays a publish. */
function runContentIntel(): void {
  if (intelRunning) return;
  intelRunning = true;
  void import("@/lib/content-intel/tick")
    .then(({ contentIntelTick }) => contentIntelTick())
    .then((result) => {
      if (result.analysed || result.accounts || result.experiments || result.reports) console.log("[ContentIntel] tick:", JSON.stringify(result));
    })
    .catch((error) => console.error("[ContentIntel] tick failed:", error instanceof Error ? error.message : error))
    .finally(() => {
      intelRunning = false;
    });
}
