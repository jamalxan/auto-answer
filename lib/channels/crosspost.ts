/**
 * Cross-posting (audit 2026-10-26, T3 "mavjud Content Scheduler orqali
 * rejalashtirish"): a Content Scheduler post keeps its Instagram master copy
 * and gets ChannelPostTarget rows for other channels. The content sweeper
 * publishes each due target at the post's slot, independently of Instagram:
 * Instagram failing does not hold the Telegram post back, and the other way.
 *
 *   PENDING → PUBLISHING (atomic claim) → PUBLISHED | FAILED
 *   transient / rate-limit errors retry on the next sweep, three attempts
 *   a PUBLISHING row older than 10 min is FAILED, never re-sent: Telegram has
 *   no idempotency key and a duplicate post in a channel is worse than a miss
 *
 * Telegram only for now; later channels plug in through their adapter.
 */

import { prisma } from "@/lib/db/client";
import { latePublishMaxMs } from "@/lib/content/config";
import { getStorage } from "@/lib/content/storage";
import { esc } from "@/lib/telegram/api";
import { takeChatSlot } from "@/lib/telegram/channel";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { deleteTelegramPost, editTelegramPost, parseExternalIds, publishToTelegram, toChannelError } from "./telegram";
import type { PostVariant } from "./types";

const MAX_ATTEMPTS = 3;
const STUCK_MS = 10 * 60_000;
const MEDIA_URL_TTL_SEC = 3600;
const BATCH = 50;

/** Post statuses that mean "this post is meant to go out at its slot". */
const LIVE_STATUSES = new Set(["SCHEDULED", "READY_TO_PUBLISH", "PREPARING", "PUBLISHING", "PUBLISHED", "PUBLISHED_MANUAL", "NEEDS_MANUAL", "FAILED"]);
/** The owner withdrew the post: its targets never publish. */
const DEAD_STATUSES = new Set(["CANCELED", "REJECTED", "EXPIRED_REVIEW"]);

export class CrossPostError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

// ─── Targets ───────────────────────────────────────────────────────────────────

/** Replace a post's Telegram targets. Published ones stay; only PENDING / FAILED rows are removed. */
export async function setTelegramTargets(workspaceId: string, postId: string, channelIds: string[]) {
  const post = await prisma.scheduledPost.findFirst({ where: { id: postId, workspaceId, deletedAt: null }, select: { id: true, type: true, status: true } });
  if (!post) throw new CrossPostError(404, "Post topilmadi");
  if (post.type === "STORY") throw new CrossPostError(409, "Story'ni Telegram'ga chiqarib bo'lmaydi");
  const wanted = [...new Set(channelIds)];
  const channels = wanted.length
    ? await prisma.telegramChannel.findMany({ where: { id: { in: wanted }, workspaceId, status: { not: "REMOVED" } }, select: { id: true } })
    : [];
  if (channels.length !== wanted.length) throw new CrossPostError(404, "Kanal topilmadi yoki uzilgan");

  const existing = await prisma.channelPostTarget.findMany({ where: { postId, channel: "telegram" } });
  for (const target of existing) {
    if (!wanted.includes(target.accountRef) && (target.status === "PENDING" || target.status === "FAILED" || target.status === "SKIPPED")) {
      await prisma.channelPostTarget.delete({ where: { id: target.id } });
    }
  }
  for (const accountRef of wanted) {
    const row = existing.find((t) => t.accountRef === accountRef);
    if (!row) {
      await prisma.channelPostTarget.create({ data: { workspaceId, postId, channel: "telegram", accountRef } });
    } else if (row.status === "FAILED" || row.status === "SKIPPED") {
      // Choosing it again is the "retry" button.
      await prisma.channelPostTarget.update({ where: { id: row.id }, data: { status: "PENDING", attempts: 0, lastError: null } });
    }
  }
  return prisma.channelPostTarget.findMany({ where: { postId, channel: "telegram" } });
}

/** The panel list: recent and upcoming posts with their Telegram targets. */
export async function listCrossPosts(workspaceId: string, now = new Date()) {
  const posts = await prisma.scheduledPost.findMany({
    where: { workspaceId, deletedAt: null, type: { not: "STORY" }, scheduledAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } },
    orderBy: { scheduledAt: "asc" },
    take: 100,
    select: { id: true, type: true, status: true, caption: true, scheduledAt: true },
  });
  const targets = posts.length
    ? await prisma.channelPostTarget.findMany({ where: { workspaceId, postId: { in: posts.map((p) => p.id) } } })
    : [];
  return posts.map((post) => ({ ...post, targets: targets.filter((t) => t.postId === post.id) }));
}

// ─── Variant building ──────────────────────────────────────────────────────────

const FORMAT_OF: Record<string, PostVariant["format"]> = {
  FEED_IMAGE: "image",
  FEED_VIDEO: "video",
  REEL: "video",
  TRIAL_REEL: "video",
  CAROUSEL: "carousel",
};

export async function buildVariant(postId: string, idempotencyKey: string): Promise<PostVariant> {
  const post = await prisma.scheduledPost.findUnique({ where: { id: postId }, select: { type: true, caption: true } });
  if (!post) throw new CrossPostError(404, "Post topilmadi");
  const media = await prisma.scheduledPostMedia.findMany({ where: { postId }, orderBy: { position: "asc" }, select: { mediaId: true } });
  const assets = media.length
    ? await prisma.mediaAsset.findMany({ where: { id: { in: media.map((m) => m.mediaId) } }, select: { id: true, kind: true, originalKey: true, preparedKey: true, sizeBytes: true, preparedBytes: true } })
    : [];
  const ordered = media.map((m) => assets.find((a) => a.id === m.mediaId)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const storage = getStorage();
  const mediaUrls: string[] = [];
  for (const asset of ordered) mediaUrls.push(await storage.presignGet(asset.preparedKey ?? asset.originalKey, MEDIA_URL_TTL_SEC));
  return {
    format: ordered.length === 0 ? "text" : FORMAT_OF[post.type] ?? "image",
    text: post.caption,
    mediaUrls,
    options: {
      kinds: ordered.map((a) => (a.kind === "VIDEO" ? "video" : "photo")),
      sizes: ordered.map((a) => (a.preparedKey && a.preparedBytes ? a.preparedBytes : Number(a.sizeBytes))),
    },
    idempotencyKey,
  };
}

// ─── Sweep ─────────────────────────────────────────────────────────────────────

export interface CrossPostSweep {
  published: number;
  failed: number;
  retried: number;
  skipped: number;
}

async function failTarget(target: { id: string; workspaceId: string; accountRef: string }, message: string) {
  await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "FAILED", lastError: message.slice(0, 500) } });
  const channel = await prisma.telegramChannel.findUnique({ where: { id: target.accountRef }, select: { title: true } });
  await notifyWorkspaceChats(target.workspaceId, `❌ <b>Telegram'ga post chiqmadi</b>\n${esc(channel?.title ?? "Kanal")}: ${esc(message.slice(0, 300))}`).catch(() => 0);
}

/** One minute tick from sweepContent. */
export async function sweepCrossPosts(now = new Date()): Promise<CrossPostSweep> {
  const result: CrossPostSweep = { published: 0, failed: 0, retried: 0, skipped: 0 };

  const stuck = await prisma.channelPostTarget.findMany({ where: { status: "PUBLISHING", updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } }, take: BATCH });
  for (const target of stuck) {
    await failTarget(target, "Natija noma'lum (jarayon to'xtab qoldi) — kanalni tekshiring, kerak bo'lsa qayta tanlang");
    result.failed++;
  }

  const pending = await prisma.channelPostTarget.findMany({ where: { status: "PENDING", channel: "telegram" }, orderBy: { createdAt: "asc" }, take: BATCH * 4 });
  if (pending.length === 0) return result;
  const posts = await prisma.scheduledPost.findMany({
    where: { id: { in: [...new Set(pending.map((t) => t.postId))] } },
    select: { id: true, status: true, scheduledAt: true, deletedAt: true, type: true },
  });
  const lateBefore = now.getTime() - latePublishMaxMs();
  let handled = 0;

  for (const target of pending) {
    if (handled >= BATCH) break;
    const post = posts.find((p) => p.id === target.postId);
    if (!post || post.deletedAt || DEAD_STATUSES.has(post.status)) {
      await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "SKIPPED", lastError: "Post bekor qilingan" } });
      result.skipped++;
      continue;
    }
    if (!post.scheduledAt || post.scheduledAt > now || !LIVE_STATUSES.has(post.status)) continue;
    if (post.type === "STORY") {
      await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "SKIPPED", lastError: "Story Telegram'da yo'q" } });
      result.skipped++;
      continue;
    }
    handled++;
    if (post.scheduledAt.getTime() < lateBefore && target.attempts === 0) {
      await failTarget(target, "Vaqt o'tib ketdi — Telegram'ga avtomatik chiqarilmadi");
      result.failed++;
      continue;
    }
    const channel = await prisma.telegramChannel.findFirst({ where: { id: target.accountRef, workspaceId: target.workspaceId } });
    if (!channel || channel.status === "REMOVED") {
      await failTarget(target, "Kanal uzilgan");
      result.failed++;
      continue;
    }
    if (channel.missingRights.includes("can_post_messages")) {
      await failTarget(target, "Botda «Xabar joylash» huquqi yo'q");
      result.failed++;
      continue;
    }

    if (!(await takeChatSlot(channel.chatId))) continue; // the channel's minute budget is spent: next sweep
    const claim = await prisma.channelPostTarget.updateMany({ where: { id: target.id, status: "PENDING" }, data: { status: "PUBLISHING", attempts: { increment: 1 } } });
    if (claim.count === 0) continue;
    try {
      const variant = await buildVariant(post.id, target.id);
      const ids = await publishToTelegram(channel.chatId, variant);
      await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "PUBLISHED", externalIds: ids.map(String), publishedAt: now, lastError: null } });
      result.published++;
    } catch (error) {
      const mapped = toChannelError(error);
      const retry = (mapped.kind === "transient" || mapped.kind === "rate_limit") && target.attempts + 1 < MAX_ATTEMPTS;
      if (retry) {
        await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "PENDING", lastError: mapped.message.slice(0, 500) } });
        result.retried++;
      } else {
        await failTarget(target, mapped.message);
        result.failed++;
      }
    }
  }
  return result;
}

// ─── Edit / delete a published cross-post ──────────────────────────────────────

async function publishedTarget(workspaceId: string, targetId: string) {
  const target = await prisma.channelPostTarget.findFirst({ where: { id: targetId, workspaceId, channel: "telegram" } });
  if (!target) throw new CrossPostError(404, "Topilmadi");
  if (target.status !== "PUBLISHED") throw new CrossPostError(409, "Post hali chiqmagan");
  const channel = await prisma.telegramChannel.findFirst({ where: { id: target.accountRef, workspaceId } });
  if (!channel || channel.status === "REMOVED") throw new CrossPostError(409, "Kanal uzilgan");
  return { target, channel, ids: parseExternalIds(target.externalIds.join(",")) };
}

export async function editCrossPost(workspaceId: string, targetId: string, text: string) {
  const { target, channel, ids } = await publishedTarget(workspaceId, targetId);
  const media = await prisma.scheduledPostMedia.count({ where: { postId: target.postId } });
  await editTelegramPost(channel.chatId, ids, text, media > 0);
}

export async function deleteCrossPost(workspaceId: string, targetId: string): Promise<boolean> {
  const { target, channel, ids } = await publishedTarget(workspaceId, targetId);
  const ok = await deleteTelegramPost(channel.chatId, ids);
  if (ok) await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "DELETED" } });
  return ok;
}
