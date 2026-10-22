/**
 * ETAP 13 — the scheduler's two BullMQ queues, separate from every other
 * queue so a long transcode or a slow Meta container can never hold up a
 * reply or a delivery.
 *
 *   content-publish  prepare (container), publish (media_publish), first-comment,
 *                    manual-notify — one post per job, delayed to its time
 *   media-process    probe / convert / thumbnail one uploaded asset
 *
 * Postgres is the source of truth: a lost job is recovered by the minute
 * sweeper (lib/content/sweep.ts). Job ids are deterministic
 * (`publish_<postId>_<attempt>`), so scheduling twice is a no-op; BullMQ
 * forbids ":" in ids. Without REDIS_URL (unit tests, scripts) scheduling
 * is a no-op and only the sweeper moves posts.
 */

import { Queue, type JobsOptions } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { isContentSchedulerEnabled } from "./config";

export const CONTENT_PUBLISH_QUEUE = "content-publish";
export const MEDIA_PROCESS_QUEUE = "media-process";

export const PREPARE_JOB = "prepare";
export const PUBLISH_JOB = "publish";
export const FIRST_COMMENT_JOB = "first-comment";
export const MANUAL_NOTIFY_JOB = "manual-notify";
export const MEDIA_PROCESS_JOB = "media-process";

export interface PublishJob {
  postId: string;
  attempt: number;
}

export interface MediaProcessJob {
  mediaId: string;
}

let publishQueue: Queue<PublishJob> | null = null;
let mediaQueue: Queue<MediaProcessJob> | null = null;

export function getContentPublishQueue(): Queue<PublishJob> {
  if (!publishQueue) {
    publishQueue = new Queue<PublishJob>(CONTENT_PUBLISH_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
        // Retries are decided by the pipeline itself (classifyPublishError);
        // a BullMQ retry would re-run a step whose state already moved on.
        attempts: 1,
      },
    });
  }
  return publishQueue;
}

export function getMediaProcessQueue(): Queue<MediaProcessJob> {
  if (!mediaQueue) {
    mediaQueue = new Queue<MediaProcessJob>(MEDIA_PROCESS_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 500 },
        removeOnFail: { age: 24 * 3600, count: 500 },
        attempts: 2,
        backoff: { type: "exponential", delay: 10_000 },
      },
    });
  }
  return mediaQueue;
}

export function hasContentQueueBackend(): boolean {
  return isContentSchedulerEnabled() && Boolean(process.env.REDIS_URL?.trim());
}

/** BullMQ forbids ":" in custom job ids. */
export function safeJobId(value: string): string {
  return value.replace(/:/g, "_");
}

export function publishJobId(postId: string, attempt: number, suffix?: string): string {
  return safeJobId(`publish_${postId}_${attempt}${suffix ? `_${suffix}` : ""}`);
}

async function addPublish(name: string, data: PublishJob, opts: JobsOptions): Promise<void> {
  if (!hasContentQueueBackend()) return;
  await getContentPublishQueue().add(name, data, opts);
}

const delayUntil = (at: Date) => Math.max(0, at.getTime() - Date.now());

/** Container creation ahead of the slot (FR-P3). */
export async function schedulePrepare(postId: string, attempt: number, at: Date): Promise<void> {
  await addPublish(PREPARE_JOB, { postId, attempt }, { jobId: publishJobId(postId, attempt, "prepare"), delay: delayUntil(at) });
}

/** media_publish at the slot itself. */
export async function schedulePublish(postId: string, attempt: number, at: Date): Promise<void> {
  await addPublish(PUBLISH_JOB, { postId, attempt }, { jobId: publishJobId(postId, attempt), delay: delayUntil(at) });
}

/** A retry of one step after a transient Meta error, under a fresh id so BullMQ accepts it. */
export async function scheduleRetry(name: string, postId: string, attempt: number, retryNo: number, delayMs: number): Promise<void> {
  await addPublish(name, { postId, attempt }, { jobId: publishJobId(postId, attempt, `${name}_r${retryNo}`), delay: delayMs });
}

export async function scheduleFirstComment(postId: string, delayMs: number, retryNo = 0): Promise<void> {
  await addPublish(FIRST_COMMENT_JOB, { postId, attempt: 0 }, { jobId: publishJobId(postId, 0, `comment_${retryNo}`), delay: delayMs });
}

/** The Telegram "publish it yourself" notice at the slot (FR-N2). */
export async function scheduleManualNotify(postId: string, attempt: number, at: Date): Promise<void> {
  await addPublish(MANUAL_NOTIFY_JOB, { postId, attempt }, { jobId: publishJobId(postId, attempt, "manual"), delay: delayUntil(at) });
}

export async function enqueueMediaProcess(mediaId: string): Promise<void> {
  if (!hasContentQueueBackend()) return;
  await getMediaProcessQueue().add(MEDIA_PROCESS_JOB, { mediaId }, { jobId: safeJobId(`media_${mediaId}`) });
}

/** Drop every pending job of one attempt (pause, unschedule, delete). Live (active) jobs finish on their own. */
export async function removePostJobs(postId: string, attempt: number): Promise<void> {
  if (!hasContentQueueBackend()) return;
  const queue = getContentPublishQueue();
  for (const suffix of ["prepare", undefined, "manual"]) {
    const job = await queue.getJob(publishJobId(postId, attempt, suffix)).catch(() => null);
    if (job) await job.remove().catch(() => undefined);
  }
}

/** Does the slot still have a waiting / delayed job? (The sweeper's "lost job" test.) */
export async function hasLivePublishJob(postId: string, attempt: number): Promise<boolean> {
  if (!hasContentQueueBackend()) return false;
  const queue = getContentPublishQueue();
  for (const suffix of ["prepare", undefined, "manual"]) {
    const job = await queue.getJob(publishJobId(postId, attempt, suffix)).catch(() => null);
    if (!job) continue;
    const state = await job.getState().catch(() => "unknown");
    if (state === "waiting" || state === "delayed" || state === "active" || state === "prioritized") return true;
  }
  return false;
}
