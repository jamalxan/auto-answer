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
 * (`publish_<postId>_<attempt>`), so scheduling twice is a no-op while the
 * job is waiting — and BullMQ refuses to re-add an id in ANY state, so a
 * finished job must be removed before its id can be scheduled again
 * (removeOnComplete / removeOnFail plus clearFinishedJob). BullMQ forbids
 * ":" in ids. Without REDIS_URL (unit tests, scripts) scheduling is a
 * no-op and only the sweeper moves posts.
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
  /** Which retry of one step this is (the pipeline counts its own backoff). */
  retryNo?: number;
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
        // History lives in PublishAttempt; a kept job blocks every re-queue of its id.
        removeOnComplete: true,
        removeOnFail: true,
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

/** A finished job under this id would make BullMQ ignore the new one: clear it first. Live jobs stay. */
async function clearFinishedJob(queue: Queue<PublishJob>, jobId: string): Promise<void> {
  const job = await queue.getJob(jobId).catch(() => null);
  if (!job) return;
  const state = await job.getState().catch(() => "unknown");
  if (state === "completed" || state === "failed") await job.remove().catch(() => undefined);
}

async function addPublish(name: string, data: PublishJob, opts: JobsOptions & { jobId: string }): Promise<void> {
  if (!hasContentQueueBackend()) return;
  const queue = getContentPublishQueue();
  await clearFinishedJob(queue, opts.jobId);
  await queue.add(name, data, opts);
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
  await addPublish(name, { postId, attempt, retryNo }, { jobId: publishJobId(postId, attempt, `${name}_r${retryNo}`), delay: delayMs });
}

/** The account lock was busy: try again shortly under a fresh id (the running job owns the plain one), same retry counter. */
export async function scheduleLockRetry(postId: string, attempt: number, retryNo: number, delayMs: number): Promise<void> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await addPublish(PUBLISH_JOB, { postId, attempt, retryNo }, { jobId: publishJobId(postId, attempt, `lock_${stamp}`), delay: delayMs });
}

export async function scheduleFirstComment(postId: string, delayMs: number, retryNo = 0): Promise<void> {
  await addPublish(FIRST_COMMENT_JOB, { postId, attempt: 0, retryNo }, { jobId: publishJobId(postId, 0, `comment_${retryNo}`), delay: delayMs });
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

export interface QueueCounts {
  waiting: number;
  delayed: number;
  active: number;
  failed: number;
}

/** M10: what the two content queues hold right now (server-wide), or null without Redis. */
export async function contentQueueCounts(): Promise<{ publish: QueueCounts; media: QueueCounts } | null> {
  if (!hasContentQueueBackend()) return null;
  const pick = (c: Record<string, number>): QueueCounts => ({ waiting: c.waiting ?? 0, delayed: c.delayed ?? 0, active: c.active ?? 0, failed: c.failed ?? 0 });
  const [publish, media] = await Promise.all([
    getContentPublishQueue().getJobCounts("waiting", "delayed", "active", "failed"),
    getMediaProcessQueue().getJobCounts("waiting", "delayed", "active", "failed"),
  ]);
  return { publish: pick(publish), media: pick(media) };
}
