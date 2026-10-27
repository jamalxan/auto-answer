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
 * Facebook / Threads / YouTube (phase 6) go through their adapter with
 * vault credentials (accountRef = ChannelCredential.id):
 *
 *   - the post's format must be one the channel publishes (capabilities);
 *     a Reel goes to Facebook as a Reel and to YouTube as a Short
 *   - an upload the platform still processes stays PUBLISHING with a
 *     pollToken and is polled each sweep (continuePublish), up to 3 h
 *   - publish_daily_limit (Threads 250, Facebook Reels 30) and YouTube's
 *     daily quota push the target to nextAttemptAt instead of failing it
 */

import { prisma } from "@/lib/db/client";
import { latePublishMaxMs } from "@/lib/content/config";
import { getStorage } from "@/lib/content/storage";
import { esc } from "@/lib/telegram/api";
import { takeChatSlot } from "@/lib/telegram/channel";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { usableCredentials } from "./access";
import { capabilitiesOf } from "./capabilities";
import { FACEBOOK_REELS_DAILY_LIMIT } from "./facebook";
import { adapterFor } from "./registry";
import { deleteTelegramPost, editTelegramPost, parseExternalIds, publishToTelegram, toChannelError } from "./telegram";
import { ChannelError, type ChannelId, type PostVariant, type PublishResult } from "./types";

const MAX_ATTEMPTS = 3;
const STUCK_MS = 10 * 60_000;
const MEDIA_URL_TTL_SEC = 3600;
const BATCH = 50;
const PROCESSING_MAX_MS = 3 * 3600_000;
const DAY_MS = 86_400_000;
/** Channels published through an adapter with vault credentials. */
export const VAULT_CHANNELS = new Set<ChannelId>(["facebook", "threads", "youtube"]);
const CHANNEL_NAME: Record<string, string> = { telegram: "Telegram", facebook: "Facebook", threads: "Threads", youtube: "YouTube" };

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

/** Replace a post's targets on one vault channel (accountRefs = ChannelCredential ids of this workspace). */
export async function setChannelTargets(workspaceId: string, postId: string, channel: ChannelId, credentialIds: string[]) {
  if (channel === "telegram") return setTelegramTargets(workspaceId, postId, credentialIds);
  if (!VAULT_CHANNELS.has(channel)) throw new CrossPostError(400, "Bu kanalga kross-post yo'q");
  const post = await prisma.scheduledPost.findFirst({ where: { id: postId, workspaceId, deletedAt: null }, select: { id: true, type: true } });
  if (!post) throw new CrossPostError(404, "Post topilmadi");
  if (post.type === "STORY") throw new CrossPostError(409, "Story'ni boshqa kanalga chiqarib bo'lmaydi");
  const wanted = [...new Set(credentialIds)];
  const creds = wanted.length
    ? await prisma.channelCredential.findMany({ where: { id: { in: wanted }, workspaceId, channel, status: { in: ["ACTIVE", "EXPIRING"] } }, select: { id: true } })
    : [];
  if (creds.length !== wanted.length) throw new CrossPostError(404, "Akkaunt topilmadi yoki ulanish ishlamayapti");

  const existing = await prisma.channelPostTarget.findMany({ where: { postId, channel } });
  for (const target of existing) {
    if (!wanted.includes(target.accountRef) && (target.status === "PENDING" || target.status === "FAILED" || target.status === "SKIPPED")) {
      await prisma.channelPostTarget.delete({ where: { id: target.id } });
    }
  }
  for (const accountRef of wanted) {
    const row = existing.find((t) => t.accountRef === accountRef);
    if (!row) {
      await prisma.channelPostTarget.create({ data: { workspaceId, postId, channel, accountRef } });
    } else if (row.status === "FAILED" || row.status === "SKIPPED") {
      await prisma.channelPostTarget.update({ where: { id: row.id }, data: { status: "PENDING", attempts: 0, lastError: null, nextAttemptAt: null, pollToken: null, pollStartedAt: null } });
    }
  }
  return prisma.channelPostTarget.findMany({ where: { postId, channel } });
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

/** A Reel is a Reel on Facebook and a Short on YouTube; elsewhere a plain video. */
function formatFor(type: string, channel: ChannelId): PostVariant["format"] {
  if (type === "REEL" || type === "TRIAL_REEL") {
    if (channel === "facebook") return "reel";
    if (channel === "youtube") return "short";
  }
  return FORMAT_OF[type] ?? "image";
}

export async function buildVariant(postId: string, idempotencyKey: string, channel: ChannelId = "telegram"): Promise<PostVariant> {
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
    format: ordered.length === 0 ? "text" : formatFor(post.type, channel),
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

async function failTarget(target: { id: string; workspaceId: string; accountRef: string; channel: string }, message: string) {
  await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "FAILED", lastError: message.slice(0, 500), pollToken: null } });
  const where =
    target.channel === "telegram"
      ? (await prisma.telegramChannel.findUnique({ where: { id: target.accountRef }, select: { title: true } }))?.title
      : (await prisma.channelCredential.findFirst({ where: { id: target.accountRef, workspaceId: target.workspaceId }, select: { label: true } }))?.label;
  const name = CHANNEL_NAME[target.channel] ?? target.channel;
  await notifyWorkspaceChats(target.workspaceId, `❌ <b>${esc(name)}'ga post chiqmadi</b>\n${esc(where ?? "Akkaunt")}: ${esc(message.slice(0, 300))}`).catch(() => 0);
}

type Target = { id: string; workspaceId: string; postId: string; channel: string; accountRef: string; attempts: number; pollToken?: string | null; pollStartedAt?: Date | null };

/** Published to this account in the last 24 h (Facebook Reels count on their own). */
async function overDailyLimit(target: Target, format: PostVariant["format"], now: Date): Promise<Date | null> {
  const channel = target.channel as ChannelId;
  const reels = channel === "facebook" && format === "reel";
  const limit = reels ? FACEBOOK_REELS_DAILY_LIMIT : capabilitiesOf(channel).publish_daily_limit;
  if (limit === null) return null;
  let recent = await prisma.channelPostTarget.findMany({
    where: { channel, accountRef: target.accountRef, status: "PUBLISHED", publishedAt: { gte: new Date(now.getTime() - DAY_MS) } },
    select: { publishedAt: true, postId: true },
  });
  if (reels) {
    const reelPosts = await prisma.scheduledPost.findMany({ where: { id: { in: recent.map((r) => r.postId) }, type: { in: ["REEL", "TRIAL_REEL"] } }, select: { id: true } });
    recent = recent.filter((r) => reelPosts.some((p) => p.id === r.postId));
  }
  if (recent.length < limit) return null;
  const oldest = recent.reduce((min, r) => (r.publishedAt && r.publishedAt < min ? r.publishedAt : min), now);
  return new Date(oldest.getTime() + DAY_MS + 60_000);
}

async function settle(target: Target, outcome: PublishResult, now: Date): Promise<"published" | "processing"> {
  if (outcome.status === "published") {
    await prisma.channelPostTarget.update({
      where: { id: target.id },
      data: { status: "PUBLISHED", externalIds: [outcome.externalId], publishedAt: now, lastError: null, pollToken: null, nextAttemptAt: null },
    });
    return "published";
  }
  await prisma.channelPostTarget.update({
    where: { id: target.id },
    data: { status: "PUBLISHING", pollToken: outcome.pollToken, pollStartedAt: target.pollStartedAt ?? now, nextAttemptAt: new Date(now.getTime() + outcome.retryAfterSec * 1000) },
  });
  return "processing";
}

/** Retry later or fail, after a publish / status-poll error. */
async function onAdapterError(target: Target, error: unknown, now: Date, result: CrossPostSweep, polling: boolean) {
  const mapped = error instanceof ChannelError ? error : new ChannelError("transient", error instanceof Error ? error.message : String(error));
  const lastError = mapped.message.slice(0, 500);
  // A known wait (YouTube quota until Pacific midnight, Meta's hour): not an attempt.
  if (mapped.kind === "rate_limit" && (mapped.retryAfterSec ?? 0) > 60) {
    const nextAttemptAt = new Date(now.getTime() + mapped.retryAfterSec! * 1000);
    await prisma.channelPostTarget.update({
      where: { id: target.id },
      data: polling ? { nextAttemptAt, lastError } : { status: "PENDING", attempts: target.attempts, nextAttemptAt, lastError },
    });
    result.retried++;
    return;
  }
  const retryable = mapped.kind === "transient" || mapped.kind === "rate_limit";
  if (polling && retryable) {
    // The upload is done; only the status read failed. Read again later.
    await prisma.channelPostTarget.update({ where: { id: target.id }, data: { nextAttemptAt: new Date(now.getTime() + 60_000), lastError } });
    result.retried++;
  } else if (!polling && retryable && target.attempts + 1 < MAX_ATTEMPTS) {
    await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "PENDING", lastError } });
    result.retried++;
  } else {
    await failTarget(target, mapped.message);
    result.failed++;
  }
}

/** Uploads the platform still processes: ask again when nextAttemptAt is due. */
async function pollProcessing(now: Date, result: CrossPostSweep) {
  const rows = await prisma.channelPostTarget.findMany({
    where: { status: "PUBLISHING", pollToken: { not: null }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    take: BATCH,
  });
  for (const target of rows) {
    if (target.pollStartedAt && now.getTime() - target.pollStartedAt.getTime() > PROCESSING_MAX_MS) {
      await failTarget(target, "Platforma videoni 3 soatda qayta ishlay olmadi");
      result.failed++;
      continue;
    }
    const adapter = adapterFor(target.channel as ChannelId);
    if (!adapter || !target.pollToken) continue;
    try {
      const creds = await usableCredentials(target.workspaceId, target.accountRef, now);
      if ((await settle(target, await adapter.continuePublish(creds, target.pollToken), now)) === "published") result.published++;
    } catch (error) {
      await onAdapterError(target, error, now, result, true);
    }
  }
}

/** One due target on a vault channel. */
async function publishViaAdapter(target: Target, postType: string, now: Date, result: CrossPostSweep) {
  const channel = target.channel as ChannelId;
  const adapter = adapterFor(channel);
  if (!adapter) {
    await failTarget(target, "Kanal adapteri yo'q");
    result.failed++;
    return;
  }
  const hasMedia = (await prisma.scheduledPostMedia.count({ where: { postId: target.postId } })) > 0;
  const format = hasMedia ? formatFor(postType, channel) : "text";
  const caps = capabilitiesOf(channel);
  if (!caps.supports_publish || !caps.publish_formats.includes(format)) {
    await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "SKIPPED", lastError: `${CHANNEL_NAME[channel] ?? channel} bu formatni qabul qilmaydi (${format})` } });
    result.skipped++;
    return;
  }
  const waitUntil = await overDailyLimit(target, format, now);
  if (waitUntil) {
    await prisma.channelPostTarget.update({ where: { id: target.id }, data: { nextAttemptAt: waitUntil, lastError: "Kunlik nashr limiti — keyinroq chiqadi" } });
    result.retried++;
    return;
  }
  const claim = await prisma.channelPostTarget.updateMany({ where: { id: target.id, status: "PENDING" }, data: { status: "PUBLISHING", attempts: { increment: 1 } } });
  if (claim.count === 0) return;
  try {
    const creds = await usableCredentials(target.workspaceId, target.accountRef, now);
    const variant = await buildVariant(target.postId, target.id, channel);
    if ((await settle(target, await adapter.publish(creds, variant), now)) === "published") result.published++;
  } catch (error) {
    await onAdapterError(target, error, now, result, false);
  }
}

/** One minute tick from sweepContent. */
export async function sweepCrossPosts(now = new Date()): Promise<CrossPostSweep> {
  const result: CrossPostSweep = { published: 0, failed: 0, retried: 0, skipped: 0 };

  // PUBLISHING without a pollToken past 10 min died mid-call (processing rows have their own 3 h cap).
  const stuck = await prisma.channelPostTarget.findMany({ where: { status: "PUBLISHING", pollToken: null, updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } }, take: BATCH });
  for (const target of stuck) {
    await failTarget(target, "Natija noma'lum (jarayon to'xtab qoldi) — kanalni tekshiring, kerak bo'lsa qayta tanlang");
    result.failed++;
  }

  await pollProcessing(now, result);

  const pending = await prisma.channelPostTarget.findMany({
    where: { status: "PENDING", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: { createdAt: "asc" },
    take: BATCH * 4,
  });
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
      await prisma.channelPostTarget.update({ where: { id: target.id }, data: { status: "SKIPPED", lastError: "Story bu kanalda yo'q" } });
      result.skipped++;
      continue;
    }
    handled++;
    // A target pushed back by a daily limit / quota is late on purpose.
    if (post.scheduledAt.getTime() < lateBefore && target.attempts === 0 && !target.nextAttemptAt) {
      await failTarget(target, `Vaqt o'tib ketdi — ${CHANNEL_NAME[target.channel] ?? target.channel}'ga avtomatik chiqarilmadi`);
      result.failed++;
      continue;
    }
    if (target.channel !== "telegram") {
      await publishViaAdapter(target, post.type, now, result);
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
