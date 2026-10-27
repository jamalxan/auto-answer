/**
 * Content intelligence, step 1 (audit 2026-10-26 "Ma'lumot yig'ish"): every
 * published post's metrics and business result.
 *
 *   metrics   Meta's single `views` metric (never the retired impressions),
 *             reach, likes, comments, saves, shares, total interactions;
 *             Reels add average watch time and skip rate, feed posts follows.
 *             Extras are asked one by one: Meta rejects the whole request
 *             when one metric is unknown for a media type.
 *   business  comments we received on the post → their authors' DMs →
 *             leads (14 days after the comment, or the post URL on the lead)
 *             → won CRM deals. This is what Metricool cannot show.
 *   score     views ÷ the account's 30-day median ("2.4× yaxshiroq"), never
 *             a raw number; null until there are three posts to compare.
 *
 * Fresh posts are re-read often (their numbers still move), old ones rarely.
 */

import { prisma } from "@/lib/db/client";
import { getAccountMedia, getMediaInsights, TokenExpiredError, PermissionError } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

const DAY_MS = 86_400_000;
export const COLLECT_DAYS = 90;
export const MEDIAN_DAYS = 30;
export const MEDIAN_MIN_POSTS = 3;
const LEAD_WINDOW_MS = 14 * DAY_MS;
const BASE_METRICS = ["views", "reach", "likes", "comments", "saved", "shares", "total_interactions"];
const FALLBACK_METRICS = ["reach", "likes", "comments", "saved", "shares"];
const REEL_EXTRAS = ["ig_reels_avg_watch_time", "reels_skip_rate"];
const FEED_EXTRAS = ["follows"];
const MEDIA_FIELDS = "id,media_type,media_product_type,permalink,timestamp,caption";

/** How stale a stat may be before it is read again, by post age. */
export function refreshAfterMs(postAgeMs: number): number {
  if (postAgeMs < 3 * DAY_MS) return 6 * 3_600_000;
  if (postAgeMs < MEDIAN_DAYS * DAY_MS) return DAY_MS;
  return 7 * DAY_MS;
}

export function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** "2.4× yaxshiroq" / "0.5× — medianadan past". */
export function scoreLabel(score: number | null): string {
  if (score === null) return "solishtirish uchun post kam";
  const rounded = Math.round(score * 10) / 10;
  if (rounded >= 1.1) return `${rounded}× yaxshiroq`;
  if (rounded <= 0.9) return `${rounded}× — medianadan past`;
  return "o'rtacha darajada";
}

type Insights = Record<string, number>;

async function readInsights(token: string, mediaId: string, isReel: boolean): Promise<Insights> {
  let base: Insights;
  try {
    base = (await getMediaInsights(token, mediaId, BASE_METRICS)) as Insights;
  } catch (error) {
    if (error instanceof TokenExpiredError || error instanceof PermissionError) throw error;
    base = (await getMediaInsights(token, mediaId, FALLBACK_METRICS)) as Insights;
  }
  for (const metric of isReel ? REEL_EXTRAS : FEED_EXTRAS) {
    try {
      Object.assign(base, await getMediaInsights(token, mediaId, [metric]));
    } catch (error) {
      if (error instanceof TokenExpiredError) throw error;
      // not available for this media / API version: leave it empty
    }
  }
  return base;
}

const int = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);

export interface CollectResult {
  fetched: number;
  skipped: number;
  failed: number;
  error: string | null;
}

/** Read the account's recent posts from Meta and refresh the stale stats. */
export async function collectAccountStats(accountId: string, now = new Date()): Promise<CollectResult> {
  const result: CollectResult = { fetched: 0, skipped: 0, failed: 0, error: null };
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: { id: true, workspaceId: true, instagramId: true, accessToken: true, tokenStatus: true },
  });
  if (!account || account.tokenStatus !== "ACTIVE") return { ...result, error: "Akkaunt ulanmagan" };
  let token: string;
  try {
    token = decryptToken(account.accessToken);
  } catch {
    return { ...result, error: "Token o'qilmadi" };
  }

  let media;
  try {
    media = await getAccountMedia(token, account.instagramId, 100, MEDIA_FIELDS);
  } catch (error) {
    return { ...result, error: error instanceof Error ? error.message : "Meta xatosi" };
  }
  const since = now.getTime() - COLLECT_DAYS * DAY_MS;
  const existing = await prisma.contentPostStat.findMany({ where: { instagramAccountId: accountId }, select: { igMediaId: true, fetchedAt: true } });
  const fetchedAt = new Map(existing.map((s) => [s.igMediaId, s.fetchedAt]));
  const posts = await prisma.scheduledPost.findMany({
    where: { instagramAccountId: accountId, igMediaId: { in: media.map((m) => m.id) } },
    select: { id: true, igMediaId: true },
  });

  for (const item of media) {
    const publishedAt = new Date(item.timestamp);
    if (Number.isNaN(publishedAt.getTime()) || publishedAt.getTime() < since) continue;
    if (item.media_product_type === "STORY") continue;
    const last = fetchedAt.get(item.id);
    if (last && now.getTime() - last.getTime() < refreshAfterMs(now.getTime() - publishedAt.getTime())) {
      result.skipped++;
      continue;
    }
    const isReel = item.media_product_type === "REELS";
    let insights: Insights;
    try {
      insights = await readInsights(token, item.id, isReel);
    } catch (error) {
      result.failed++;
      if (error instanceof TokenExpiredError || error instanceof PermissionError) {
        result.error = error.message;
        break;
      }
      continue;
    }
    const data = {
      mediaType: item.media_type,
      productType: item.media_product_type ?? null,
      permalink: item.permalink ?? null,
      caption: (item as { caption?: string }).caption?.slice(0, 2200) ?? null,
      publishedAt,
      views: int(insights.views),
      reach: int(insights.reach),
      likes: int(insights.likes),
      comments: int(insights.comments),
      saves: int(insights.saved),
      shares: int(insights.shares),
      follows: int(insights.follows),
      totalInteractions: int(insights.total_interactions),
      avgWatchMs: int(insights.ig_reels_avg_watch_time),
      skipRate: typeof insights.reels_skip_rate === "number" ? insights.reels_skip_rate : null,
      scheduledPostId: posts.find((p) => p.igMediaId === item.id)?.id ?? null,
      fetchedAt: now,
    };
    await prisma.contentPostStat.upsert({
      where: { instagramAccountId_igMediaId: { instagramAccountId: accountId, igMediaId: item.id } },
      create: { workspaceId: account.workspaceId, instagramAccountId: accountId, igMediaId: item.id, ...data },
      update: data,
    });
    result.fetched++;
  }

  await attributeBusiness(accountId, now);
  await rescore(accountId, now);
  return result;
}

/** comments → DMs → leads → sales for the account's posts of the last 30 days. */
export async function attributeBusiness(accountId: string, now = new Date()): Promise<void> {
  const stats = await prisma.contentPostStat.findMany({
    where: { instagramAccountId: accountId, publishedAt: { gte: new Date(now.getTime() - MEDIAN_DAYS * DAY_MS) } },
    select: { id: true, igMediaId: true, permalink: true, publishedAt: true },
  });
  for (const stat of stats) {
    const comments = await prisma.instagramEvent.findMany({
      where: { instagramAccountId: accountId, eventType: "COMMENT", mediaId: stat.igMediaId },
      select: { senderId: true, timestamp: true },
    });
    const firstComment = new Map<string, Date>();
    for (const c of comments) {
      const seen = firstComment.get(c.senderId);
      if (!seen || c.timestamp < seen) firstComment.set(c.senderId, c.timestamp);
    }
    const authors = [...firstComment.keys()];
    const dms = authors.length
      ? await prisma.conversation.count({ where: { instagramAccountId: accountId, igUserId: { in: authors }, createdAt: { gte: stat.publishedAt } } })
      : 0;
    const candidates = await prisma.lead.findMany({
      where: {
        instagramAccountId: accountId,
        isTest: false,
        createdAt: { gte: stat.publishedAt },
        OR: [{ igUserId: { in: authors } }, ...(stat.permalink ? [{ postUrl: stat.permalink }] : [])],
      },
      select: { id: true, igUserId: true, postUrl: true, createdAt: true },
    });
    const leads = candidates.filter((lead) => {
      if (stat.permalink && lead.postUrl === stat.permalink) return true;
      const commented = firstComment.get(lead.igUserId);
      return Boolean(commented && lead.createdAt.getTime() - commented.getTime() <= LEAD_WINDOW_MS && lead.createdAt >= commented);
    });
    const sales = leads.length ? await prisma.crmDeal.count({ where: { leadId: { in: leads.map((l) => l.id) }, wonAt: { not: null } } }) : 0;
    await prisma.contentPostStat.update({
      where: { id: stat.id },
      data: { bizComments: comments.length, bizDms: dms, bizLeads: leads.length, bizSales: sales },
    });
  }
}

/** score = views ÷ median views of the account's posts of the last 30 days. */
export async function rescore(accountId: string, now = new Date()): Promise<number | null> {
  const recent = await prisma.contentPostStat.findMany({
    where: { instagramAccountId: accountId, publishedAt: { gte: new Date(now.getTime() - MEDIAN_DAYS * DAY_MS) }, views: { not: null } },
    select: { views: true },
  });
  let pool = recent.map((s) => s.views as number);
  if (pool.length < MEDIAN_MIN_POSTS) {
    const older = await prisma.contentPostStat.findMany({ where: { instagramAccountId: accountId, views: { not: null } }, select: { views: true } });
    pool = older.map((s) => s.views as number);
  }
  const base = pool.length >= MEDIAN_MIN_POSTS ? median(pool) : null;
  const all = await prisma.contentPostStat.findMany({ where: { instagramAccountId: accountId }, select: { id: true, views: true, score: true } });
  for (const stat of all) {
    const score = base && base > 0 && stat.views !== null ? Math.round((stat.views / base) * 100) / 100 : null;
    if (score !== stat.score) await prisma.contentPostStat.update({ where: { id: stat.id }, data: { score } });
  }
  return base;
}
