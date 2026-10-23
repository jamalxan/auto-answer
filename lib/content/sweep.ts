/**
 * ETAP 13 — the minute sweeper (spec §7 "Aniqlik va ishonchlilik"). Postgres
 * is the source of truth; BullMQ only carries the alarm clock. Every minute
 * (worker maintenance tick and /api/cron/content-sweep):
 *
 *   1. due SCHEDULED / READY_TO_PUBLISH posts without a live job → publish job now
 *      (a Redis flush or a crash must not lose a slot), unless they are past
 *      the late window → FAILED (PUBLISH_LATE)
 *   2. due manual posts → the Telegram notice
 *   3. PREPARING rows stuck past the video ceiling → FAILED;
 *      PUBLISHING rows untouched for five minutes → ask Meta what happened (recoverStuckPublishing)
 *   4. READY_TO_PUBLISH containers close to Meta's 24 h expiry → SCHEDULED again
 *   5. PUBLISHED_MANUAL posts without a media id → bind from the account media
 */

import { prisma } from "@/lib/db/client";
import { CONTAINER_MAX_AGE_MS, CONTAINER_MAX_WAIT_MS, latePublishMaxMs } from "./config";
import { bindManualPost, sendManualNotice } from "./manual";
import { failPost, recoverStuckPublishing } from "./publish";
import { hasLivePublishJob, schedulePublish } from "./queue";

export interface SweepResult {
  requeued: number;
  late: number;
  manual: number;
  stale: number;
  recovered: number;
  expiredContainers: number;
  bound: number;
}

const STUCK_PREPARING_MS = CONTAINER_MAX_WAIT_MS.video + 5 * 60_000;
/** media_publish answers in seconds; a PUBLISHING row this old lost its worker. */
const STUCK_PUBLISHING_MS = 5 * 60_000;
const BIND_WINDOW_MS = 30 * 60_000;
const BATCH = 200;

export async function sweepContent(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { requeued: 0, late: 0, manual: 0, stale: 0, recovered: 0, expiredContainers: 0, bound: 0 };
  const lateBefore = new Date(now.getTime() - latePublishMaxMs());

  // 1 + 2: everything whose time has come.
  const due = await prisma.scheduledPost.findMany({
    where: { deletedAt: null, status: { in: ["SCHEDULED", "READY_TO_PUBLISH"] }, scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: BATCH,
    select: { id: true, attempts: true, scheduledAt: true, autoPublish: true, manualReason: true, status: true },
  });
  for (const post of due) {
    const manual = !post.autoPublish || Boolean(post.manualReason);
    if (manual) {
      await sendManualNotice(post.id, { now: () => now }).catch((e) => console.error("[Content] manual notice failed:", e instanceof Error ? e.message : e));
      result.manual++;
      continue;
    }
    if (post.scheduledAt && post.scheduledAt < lateBefore) {
      await failPost(post.id, "PUBLISH_LATE", "Vaqt o'tib ketdi — post avtomatik chiqarilmadi. Hozir chiqaraymi? (Qayta urinish)", { step: "PUBLISH" });
      result.late++;
      continue;
    }
    if (await hasLivePublishJob(post.id, post.attempts)) continue;
    await schedulePublish(post.id, post.attempts, now);
    result.requeued++;
  }

  // 3: a worker died mid-prepare.
  const stuck = await prisma.scheduledPost.findMany({
    where: { deletedAt: null, status: "PREPARING", updatedAt: { lt: new Date(now.getTime() - STUCK_PREPARING_MS) } },
    take: BATCH,
    select: { id: true },
  });
  for (const post of stuck) {
    await failPost(post.id, "PUBLISH_CONTAINER_TIMEOUT", "Instagram videoni qayta ishlay olmadi (tayyorlash to'xtab qoldi) — qayta urinib ko'ring", { step: "STATUS" });
    result.stale++;
  }

  // 3b: a worker died between PUBLISHING and the final update — Meta knows whether it went out.
  const halted = await prisma.scheduledPost.findMany({
    where: { deletedAt: null, status: "PUBLISHING", updatedAt: { lt: new Date(now.getTime() - STUCK_PUBLISHING_MS) } },
    take: BATCH,
    select: { id: true },
  });
  for (const post of halted) {
    await recoverStuckPublishing(post.id, { now: () => now }).catch((e) => console.error("[Content] recover failed:", e instanceof Error ? e.message : e));
    result.recovered++;
  }

  // 4: never publish an expired container.
  const expiring = await prisma.scheduledPost.updateMany({
    where: { deletedAt: null, status: "READY_TO_PUBLISH", containerCreatedAt: { lt: new Date(now.getTime() - CONTAINER_MAX_AGE_MS) } },
    data: { status: "SCHEDULED", containerId: null, containerStatus: null, containerCreatedAt: null, version: { increment: 1 } },
  });
  result.expiredContainers = expiring.count;

  // 5: manual posts confirmed in the last half hour.
  const unbound = await prisma.scheduledPost.findMany({
    where: { deletedAt: null, status: "PUBLISHED_MANUAL", igMediaId: null, publishedAt: { gte: new Date(now.getTime() - BIND_WINDOW_MS) } },
    take: BATCH,
    select: { id: true },
  });
  for (const post of unbound) {
    if (await bindManualPost(post.id).catch(() => false)) result.bound++;
  }

  return result;
}
