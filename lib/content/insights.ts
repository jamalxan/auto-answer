/**
 * ETAP 13 Faza 2 (WP-D) — what the calendar learns from Instagram:
 *
 * FR-V3 feed grid. The last 12 published media from Meta (cached 10 min)
 * under the account's planned feed posts, in the order they will appear on
 * the profile — the furthest future post top-left, like Instagram puts the
 * newest first. Drafts with a planned time are included (the UI fades
 * them); stories and Trial Reels never reach the grid, Reels only with
 * share_to_feed. When Meta fails the grid falls back to the posts we
 * published ourselves and says why.
 *
 * FR-S7 best times. A 7×24 score (weekday 0 = Monday, hours in the
 * workspace zone, 0…1 with the best cell = 1):
 *   1. followers_count ≥ 100 → `online_followers` (last 30 days) averaged;
 *   2. otherwise the account's own posts of the last 90 days — reach per
 *      publish hour when Meta gives reach for every sampled post, likes +
 *      comments otherwise (neighbouring hours get half weight, so a sparse
 *      history still paints a usable map);
 *   3. otherwise `{ source: "none" }` → "Ma'lumot yetarli emas".
 * Cached 6 h per account and zone (10 min when Meta failed). Cache: Redis
 * when REDIS_URL is set, an in-process map otherwise — no migration.
 */

import { prisma } from "@/lib/db/client";
import { getAccountMedia, getMediaInsights, getOnlineFollowers, getUserInfo, PermissionError, RateLimitError, TokenExpiredError, type FeedMedia } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getRedisConnection } from "@/lib/queue/client";
import { notFound } from "./errors";
import { signedMediaUrl } from "./media";
import type { PostStatusValue, PostTypeValue } from "./schema";
import { DEFAULT_TIMEZONE, utcToZoned } from "./time";

export const FEED_CACHE_MS = 10 * 60_000;
export const BEST_TIMES_CACHE_MS = 6 * 3_600_000;
const FAILURE_CACHE_MS = 10 * 60_000;
export const FEED_PUBLISHED = 12;
export const FOLLOWERS_FOR_ONLINE = 100;
export const OWN_POSTS_DAYS = 90;
export const OWN_POSTS_MIN = 5;
const REACH_SAMPLE = 30;

// ─── Cache ──────────────────────────────────────────────────────────────────

const local = new Map<string, { until: number; value: string }>();

export function clearInsightsCache(): void {
  local.clear();
}

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    if (!process.env.REDIS_URL?.trim()) {
      const hit = local.get(key);
      if (!hit || hit.until < Date.now()) return null;
      return JSON.parse(hit.value) as T;
    }
    const raw = await getRedisConnection().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  const raw = JSON.stringify(value);
  try {
    if (!process.env.REDIS_URL?.trim()) {
      local.set(key, { until: Date.now() + ttlMs, value: raw });
      return;
    }
    await getRedisConnection().set(key, raw, "PX", ttlMs);
  } catch {
    // A cache that cannot write only costs a Meta call next time.
  }
}

// ─── Shared ─────────────────────────────────────────────────────────────────

async function ownedAccount(workspaceId: string, accountId: string) {
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: { id: true, workspaceId: true, instagramId: true, accessToken: true, username: true },
  });
  if (!account || account.workspaceId !== workspaceId) throw notFound("Instagram akkaunt topilmadi");
  return account;
}

async function workspaceZone(workspaceId: string): Promise<string> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
  return ws?.timezone || DEFAULT_TIMEZONE;
}

/** Why Meta did not answer, in words the user can act on. */
export function metaFailureText(error: unknown): string {
  if (error instanceof TokenExpiredError) return "Instagram ulanishi uzildi — akkauntni qayta ulang";
  if (error instanceof PermissionError) return "Instagram ma'lumotlarini o'qishga ruxsat yo'q — akkauntni qayta ulang";
  if (error instanceof RateLimitError) return "Instagram so'rov limitiga yetildi — birozdan keyin qayta urinib ko'ring";
  return "Instagram vaqtincha javob bermadi — birozdan keyin qayta urinib ko'ring";
}

// ─── FR-V3 feed grid ────────────────────────────────────────────────────────

export interface FeedTile {
  key: string;
  source: "instagram" | "planned";
  postId: string | null;
  mediaType: string;
  imageUrl: string | null;
  permalink: string | null;
  at: string;
  status: PostStatusValue | null;
  draft: boolean;
}

export interface AccountFeed {
  accountId: string;
  username: string;
  timezone: string;
  /** Planned first (furthest future first), then published, newest first. */
  items: FeedTile[];
  /** Where the published part came from: Meta, or our own records when Meta failed. */
  publishedSource: "instagram" | "local";
  /** Set when Meta failed: why the published part may be incomplete. */
  notice: string | null;
}

const PLANNED_STATUSES: PostStatusValue[] = ["DRAFT", "PENDING_REVIEW", "SCHEDULED", "PAUSED", "PREPARING", "READY_TO_PUBLISH", "PUBLISHING", "NEEDS_MANUAL"];
const NOT_IN_GRID: PostTypeValue[] = ["STORY", "TRIAL_REEL"];

function tileOfMeta(m: FeedMedia): FeedTile {
  return {
    key: `ig:${m.id}`,
    source: "instagram",
    postId: null,
    mediaType: m.media_type,
    imageUrl: m.media_type === "VIDEO" ? (m.thumbnail_url ?? null) : (m.media_url ?? m.thumbnail_url ?? null),
    permalink: m.permalink ?? null,
    at: m.timestamp,
    status: null,
    draft: false,
  };
}

type PublishedPart = { tiles: FeedTile[]; source: "instagram" | "local"; notice: string | null };

export async function accountFeed(workspaceId: string, accountId: string): Promise<AccountFeed> {
  const account = await ownedAccount(workspaceId, accountId);
  const timezone = await workspaceZone(workspaceId);

  const cacheKey = `content:feed:${accountId}`;
  let published = await cacheGet<PublishedPart>(cacheKey);
  if (!published) {
    try {
      const media = await getAccountMedia(decryptToken(account.accessToken), account.instagramId, FEED_PUBLISHED);
      published = { tiles: media.slice(0, FEED_PUBLISHED).map(tileOfMeta), source: "instagram", notice: null };
      await cacheSet(cacheKey, published, FEED_CACHE_MS);
    } catch (error) {
      console.warn("[Content] feed grid: Meta media failed:", error instanceof Error ? error.message : error);
      const ours = await prisma.scheduledPost.findMany({
        where: { workspaceId, instagramAccountId: accountId, deletedAt: null, status: { in: ["PUBLISHED", "PUBLISHED_MANUAL"] }, type: { notIn: NOT_IN_GRID } },
        orderBy: { publishedAt: "desc" },
        take: FEED_PUBLISHED,
        include: { media: { include: { media: { select: { thumbKey: true } } }, orderBy: { position: "asc" } } },
      });
      const tiles = await Promise.all(
        ours.map(async (p) => ({
          key: `post:${p.id}`,
          source: "instagram" as const,
          postId: p.id,
          mediaType: p.type,
          imageUrl: p.media[0]?.media?.thumbKey ? await signedMediaUrl(p.media[0].media.thumbKey) : null,
          permalink: p.permalink ?? null,
          at: (p.publishedAt ?? p.scheduledAt ?? p.createdAt).toISOString(),
          status: p.status,
          draft: false,
        }))
      );
      published = { tiles, source: "local", notice: `${metaFailureText(error)}. Grid'da faqat SocialAuto orqali chiqqan postlar ko'rsatilmoqda.` };
    }
  }

  const rows = await prisma.scheduledPost.findMany({
    where: { workspaceId, instagramAccountId: accountId, deletedAt: null, status: { in: PLANNED_STATUSES }, type: { notIn: NOT_IN_GRID }, scheduledAt: { not: null } },
    orderBy: { scheduledAt: "desc" },
    take: 60,
    include: { media: { include: { media: { select: { thumbKey: true } } }, orderBy: { position: "asc" } } },
  });
  const planned = await Promise.all(
    rows
      .filter((p) => p.scheduledAt && !(p.type === "REEL" && p.shareToFeed === false))
      .slice(0, 30)
      .map(async (p) => ({
        key: `post:${p.id}`,
        source: "planned" as const,
        postId: p.id,
        mediaType: p.type,
        imageUrl: p.media[0]?.media?.thumbKey ? await signedMediaUrl(p.media[0].media.thumbKey) : null,
        permalink: null,
        at: (p.scheduledAt as Date).toISOString(),
        status: p.status,
        draft: p.status === "DRAFT",
      }))
  );

  return { accountId, username: account.username, timezone, items: [...planned, ...published.tiles], publishedSource: published.source, notice: published.notice };
}

// ─── FR-S7 best times ───────────────────────────────────────────────────────

export interface BestTimeCell {
  weekday: number;
  hour: number;
  score: number;
}

export interface BestTimes {
  source: "online_followers" | "own_posts" | "none";
  /** What own-post scores are made of. */
  metric: "online_followers" | "reach" | "engagement" | null;
  timezone: string;
  /** 7 rows (Monday first) × 24 hours, 0…1; null when source = none. */
  scores: number[][] | null;
  /** The three best cells, best first. */
  top: BestTimeCell[];
  /** Days of online_followers, or posts of the last 90 days, behind the scores. */
  sample: number;
  followers: number | null;
  /** Why there is no map (source = none), or a Meta problem met on the way. */
  reason: string | null;
  computedAt: string;
}

/** Monday-first weekday and hour of an instant in `tz`. */
export function zonedWeekHour(at: Date, tz: string): { weekday: number; hour: number } {
  const { date, time } = utcToZoned(at, tz);
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return { weekday, hour: Number(time.slice(0, 2)) };
}

const emptyGrid = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

/** Mean per cell, scaled so the best cell is 1 (rounded to 3 decimals). */
export function normalizeGrid(sum: number[][], count: number[][]): number[][] {
  const mean = sum.map((row, d) => row.map((v, h) => (count[d][h] ? v / count[d][h] : 0)));
  const max = Math.max(0, ...mean.flat());
  return mean.map((row) => row.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0)));
}

export function topCells(scores: number[][], n = 3): BestTimeCell[] {
  const cells: BestTimeCell[] = [];
  scores.forEach((row, weekday) => row.forEach((score, hour) => score > 0 && cells.push({ weekday, hour, score })));
  return cells.sort((a, b) => b.score - a.score || a.weekday - b.weekday || a.hour - b.hour).slice(0, n);
}

/** online_followers days → the grid: hour h of a day is end_time − 24 h + h, read in `tz`. */
export function gridFromOnlineFollowers(days: Array<{ endTime: string; hours: Record<string, number> }>, tz: string): { scores: number[][]; sample: number } | null {
  const sum = emptyGrid();
  const count = emptyGrid();
  let sample = 0;
  for (const day of days) {
    const end = new Date(day.endTime).getTime();
    if (Number.isNaN(end)) continue;
    let any = false;
    for (const [key, value] of Object.entries(day.hours)) {
      const h = Number(key);
      if (!Number.isInteger(h) || h < 0 || h > 23 || typeof value !== "number") continue;
      const { weekday, hour } = zonedWeekHour(new Date(end - 86_400_000 + h * 3_600_000), tz);
      sum[weekday][hour] += value;
      count[weekday][hour] += 1;
      any = true;
    }
    if (any) sample++;
  }
  if (sample === 0) return null;
  const scores = normalizeGrid(sum, count);
  return scores.flat().some((v) => v > 0) ? { scores, sample } : null;
}

/** Own posts → the grid; a post counts fully at its hour and at half its value on the hours either side. */
export function gridFromPosts(posts: Array<{ at: Date; value: number }>, tz: string): number[][] {
  const sum = emptyGrid();
  const count = emptyGrid();
  for (const post of posts) {
    const { weekday, hour } = zonedWeekHour(post.at, tz);
    for (const [dh, w] of [[0, 1], [-1, 0.5], [1, 0.5]] as const) {
      const h = (hour + dh + 24) % 24;
      const d = hour + dh < 0 ? (weekday + 6) % 7 : hour + dh > 23 ? (weekday + 1) % 7 : weekday;
      sum[d][h] += post.value * w;
      count[d][h] += 1;
    }
  }
  return normalizeGrid(sum, count);
}

export async function bestTimes(workspaceId: string, accountId: string, opts: { now?: Date; fresh?: boolean } = {}): Promise<BestTimes> {
  const now = opts.now ?? new Date();
  const account = await ownedAccount(workspaceId, accountId);
  const timezone = await workspaceZone(workspaceId);
  const cacheKey = `content:best-times:${accountId}:${timezone}`;
  if (!opts.fresh) {
    const hit = await cacheGet<BestTimes>(cacheKey);
    if (hit) return hit;
  }

  const base = { timezone, computedAt: now.toISOString() };
  let token: string;
  try {
    token = decryptToken(account.accessToken);
  } catch {
    return { ...base, source: "none", metric: null, scores: null, top: [], sample: 0, followers: null, reason: "Akkaunt tokeni o'qilmadi — akkauntni qayta ulang" };
  }

  let followers: number | null = null;
  let problem: string | null = null;
  try {
    followers = (await getUserInfo(token)).followers_count ?? null;
  } catch (error) {
    problem = metaFailureText(error);
  }

  if (followers !== null && followers >= FOLLOWERS_FOR_ONLINE) {
    try {
      const grid = gridFromOnlineFollowers(await getOnlineFollowers(token, account.instagramId, now), timezone);
      if (grid) {
        const result: BestTimes = { ...base, source: "online_followers", metric: "online_followers", scores: grid.scores, top: topCells(grid.scores), sample: grid.sample, followers, reason: null };
        await cacheSet(cacheKey, result, BEST_TIMES_CACHE_MS);
        return result;
      }
    } catch (error) {
      console.warn("[Content] best times: online_followers failed:", error instanceof Error ? error.message : error);
    }
  }

  try {
    const since = now.getTime() - OWN_POSTS_DAYS * 86_400_000;
    const media = (await getAccountMedia(token, account.instagramId, 100, "id,media_type,timestamp,like_count,comments_count")).filter((m) => {
      const t = new Date(m.timestamp).getTime();
      return !Number.isNaN(t) && t >= since && t <= now.getTime();
    });
    if (media.length >= OWN_POSTS_MIN) {
      const sampled = media.slice(0, REACH_SAMPLE);
      const reach = await Promise.all(sampled.map((m) => getMediaInsights(token, m.id, ["reach"]).then((r) => r.reach ?? null).catch(() => null)));
      const useReach = reach.every((r) => typeof r === "number");
      const posts = useReach
        ? sampled.map((m, i) => ({ at: new Date(m.timestamp), value: reach[i] as number }))
        : media.map((m) => ({ at: new Date(m.timestamp), value: (m.like_count ?? 0) + (m.comments_count ?? 0) }));
      const scores = gridFromPosts(posts, timezone);
      if (scores.flat().some((v) => v > 0)) {
        const result: BestTimes = { ...base, source: "own_posts", metric: useReach ? "reach" : "engagement", scores, top: topCells(scores), sample: posts.length, followers, reason: null };
        await cacheSet(cacheKey, result, BEST_TIMES_CACHE_MS);
        return result;
      }
    }
  } catch (error) {
    problem = problem ?? metaFailureText(error);
  }

  const result: BestTimes = {
    ...base,
    source: "none",
    metric: null,
    scores: null,
    top: [],
    sample: 0,
    followers,
    reason: problem ?? `Ma'lumot yetarli emas: ${FOLLOWERS_FOR_ONLINE} ta obunachi yoki so'nggi ${OWN_POSTS_DAYS} kunda kamida ${OWN_POSTS_MIN} ta post kerak`,
  };
  await cacheSet(cacheKey, result, problem ? FAILURE_CACHE_MS : BEST_TIMES_CACHE_MS);
  return result;
}
