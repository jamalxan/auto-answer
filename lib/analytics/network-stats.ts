/**
 * Statistics across every connected network (2026-11-05, "all networks are
 * equal"). One row per connected account, whatever the network:
 *
 *   published / failed   posts that went out (or failed) in the range, from
 *                        our own publish records (ScheduledPost for Instagram,
 *                        ChannelPostTarget for the others)
 *   inbound / replies    comments and messages received and answered (DmLog
 *                        for Instagram automations, ChannelMessage elsewhere)
 *   metrics              views / likes / comments / shares of the posts
 *                        published in the range: Instagram from the stored
 *                        ContentPostStat rows, Facebook / Threads / YouTube
 *                        fetched live for the latest posts (cached), Telegram
 *                        none (the Bot API has no view counts)
 *
 * A metrics failure never breaks the page: the row keeps its counts and
 * carries a short note instead.
 */

import { prisma } from "@/lib/db/client";
import { usableCredentials } from "@/lib/channels/access";
import { facebookPostCounts } from "@/lib/channels/facebook";
import { adapterFor } from "@/lib/channels/registry";
import { ChannelError, type ChannelCredentials } from "@/lib/channels/types";

export type StatsNetwork = "instagram" | "facebook" | "threads" | "youtube" | "telegram";
export const STATS_NETWORKS: StatsNetwork[] = ["instagram", "facebook", "threads", "youtube", "telegram"];

export interface Metrics {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
}

export interface AccountStats {
  network: StatsNetwork;
  id: string;
  label: string;
  published: number;
  failed: number;
  inbound: number;
  replies: number;
  metrics: Metrics | null;
  /** Posts the metrics cover (the latest few for live-fetched networks). */
  metricsPosts: number;
  note: string | null;
}

export interface NetworkStats {
  days: number;
  since: string;
  accounts: AccountStats[];
  totals: Record<StatsNetwork, { accounts: number; published: number; failed: number; inbound: number; replies: number; metrics: Metrics | null }>;
}

/** Live metrics are fetched for at most this many latest posts per account. */
export const LIVE_POSTS_PER_ACCOUNT = 10;
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; metrics: Record<string, number> }>();

const EMPTY: Metrics = { views: null, likes: null, comments: null, shares: null };

function addMetrics(into: Metrics, raw: Partial<Record<keyof Metrics, number | null | undefined>>): Metrics {
  const out = { ...into };
  for (const key of Object.keys(EMPTY) as Array<keyof Metrics>) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

type LiveNetwork = "facebook" | "threads" | "youtube";

async function liveMetrics(network: LiveNetwork, creds: ChannelCredentials, externalId: string, now: number): Promise<Record<string, number>> {
  const key = `${network}:${externalId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.metrics;
  let metrics: Record<string, number>;
  if (network === "facebook") metrics = await facebookPostCounts(creds, externalId);
  else {
    const adapter = adapterFor(network);
    if (!adapter) throw new ChannelError("not_supported", `${network} adapteri yo'q`);
    const res = await adapter.fetchInsights(creds, externalId, network === "threads" ? ["views", "likes", "replies", "reposts", "quotes"] : []);
    metrics = res.metrics;
    // Threads calls comments "replies" and has reposts + quotes for shares.
    if (network === "threads") metrics = { views: metrics.views, likes: metrics.likes, comments: metrics.replies, shares: (metrics.reposts ?? 0) + (metrics.quotes ?? 0) };
  }
  cache.set(key, { at: now, metrics });
  if (cache.size > 5000) cache.delete(cache.keys().next().value as string);
  return metrics;
}

function noteFor(error: unknown): string {
  if (error instanceof ChannelError) {
    if (error.kind === "auth") return "Ulanish ishlamayapti — qayta ulang";
    if (error.kind === "permission") return "Statistika ruxsati berilmagan — qayta ulang";
    if (error.kind === "rate_limit") return "Platforma limiti: keyinroq yangilanadi";
  }
  return "Statistikani olib bo'lmadi";
}

export async function getNetworkStats(workspaceId: string, opts: { days: number; now?: Date; live?: boolean }): Promise<NetworkStats> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.days * 24 * 60 * 60 * 1000);
  const live = opts.live ?? true;

  const [igAccounts, credentials, tgChannels] = await Promise.all([
    prisma.instagramAccount.findMany({ where: { workspaceId }, select: { id: true, username: true, tokenLastError: true }, orderBy: { connectedAt: "asc" } }),
    prisma.channelCredential.findMany({
      where: { workspaceId, channel: { in: ["facebook", "threads", "youtube"] }, status: { not: "REVOKED" } },
      select: { id: true, channel: true, label: true, externalAccountId: true, status: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.telegramChannel.findMany({ where: { workspaceId, status: { not: "REMOVED" } }, select: { id: true, title: true, username: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const instagram = igAccounts.filter((a) => a.tokenLastError !== "Disconnected by user");
  const igIds = instagram.map((a) => a.id);

  const [igPublished, igFailed, targetRows, dmIn, dmOut, messages, igStats] = await Promise.all([
    igIds.length
      ? prisma.scheduledPost.groupBy({ by: ["instagramAccountId"], where: { workspaceId, instagramAccountId: { in: igIds }, deletedAt: null, status: { in: ["PUBLISHED", "PUBLISHED_MANUAL"] }, publishedAt: { gte: since, lte: now } }, _count: { _all: true } })
      : Promise.resolve([]),
    igIds.length
      ? prisma.scheduledPost.groupBy({ by: ["instagramAccountId"], where: { workspaceId, instagramAccountId: { in: igIds }, deletedAt: null, status: "FAILED", updatedAt: { gte: since, lte: now } }, _count: { _all: true } })
      : Promise.resolve([]),
    prisma.channelPostTarget.groupBy({
      by: ["channel", "accountRef", "status"],
      where: { workspaceId, status: { in: ["PUBLISHED", "FAILED"] }, OR: [{ publishedAt: { gte: since, lte: now } }, { status: "FAILED", updatedAt: { gte: since, lte: now } }] },
      _count: { _all: true },
    }),
    igIds.length ? prisma.dmLog.groupBy({ by: ["instagramAccountId"], where: { workspaceId, instagramAccountId: { in: igIds }, createdAt: { gte: since, lte: now } }, _count: { _all: true } }) : Promise.resolve([]),
    igIds.length
      ? prisma.dmLog.groupBy({ by: ["instagramAccountId"], where: { workspaceId, instagramAccountId: { in: igIds }, status: "SENT", createdAt: { gte: since, lte: now } }, _count: { _all: true } })
      : Promise.resolve([]),
    prisma.channelMessage.groupBy({ by: ["accountRef", "direction"], where: { workspaceId, createdAt: { gte: since, lte: now } }, _count: { _all: true } }),
    igIds.length
      ? prisma.contentPostStat.groupBy({
          by: ["instagramAccountId"],
          where: { workspaceId, instagramAccountId: { in: igIds }, publishedAt: { gte: since, lte: now } },
          _sum: { views: true, likes: true, comments: true, shares: true },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  const count = <T extends { _count: { _all: number } }>(rows: T[], pick: (r: T) => boolean) => rows.filter(pick).reduce((n, r) => n + r._count._all, 0);
  const msg = (ref: string, direction: "IN" | "OUT") => count(messages, (m) => m.accountRef === ref && m.direction === direction);
  const target = (ref: string, status: string) => count(targetRows, (t) => t.accountRef === ref && t.status === status);

  const accounts: AccountStats[] = [];

  for (const a of instagram) {
    const stat = igStats.find((s) => s.instagramAccountId === a.id);
    accounts.push({
      network: "instagram",
      id: a.id,
      label: `@${a.username}`,
      published: count(igPublished, (r) => r.instagramAccountId === a.id),
      failed: count(igFailed, (r) => r.instagramAccountId === a.id),
      inbound: count(dmIn, (r) => r.instagramAccountId === a.id),
      replies: count(dmOut, (r) => r.instagramAccountId === a.id),
      metrics: stat ? addMetrics(EMPTY, stat._sum) : null,
      metricsPosts: stat?._count._all ?? 0,
      note: stat ? null : "Postlar statistikasi hali yig'ilmagan",
    });
  }

  for (const c of credentials) {
    const network = c.channel as "facebook" | "threads" | "youtube";
    accounts.push({
      network,
      id: c.id,
      label: c.label ?? c.externalAccountId,
      published: target(c.id, "PUBLISHED"),
      failed: target(c.id, "FAILED"),
      inbound: msg(c.id, "IN"),
      replies: msg(c.id, "OUT"),
      metrics: null,
      metricsPosts: 0,
      note: c.status === "ERROR" ? "Ulanish ishlamayapti — qayta ulang" : null,
    });
  }

  for (const t of tgChannels) {
    accounts.push({
      network: "telegram",
      id: t.id,
      label: t.title ?? (t.username ? `@${t.username}` : "Telegram kanal"),
      published: target(t.id, "PUBLISHED"),
      failed: target(t.id, "FAILED"),
      inbound: msg(t.id, "IN"),
      replies: msg(t.id, "OUT"),
      metrics: null,
      metricsPosts: 0,
      note: "Telegram bot ko'rishlar sonini bermaydi",
    });
  }

  if (live) {
    const vault = accounts.filter((a) => isLive(a.network) && a.published > 0 && !a.note);
    await Promise.all(vault.map((acc) => liveForAccount(workspaceId, acc, since, now)));
  }

  return { days: opts.days, since: since.toISOString(), accounts, totals: totalsOf(accounts) };
}

function isLive(network: StatsNetwork): network is LiveNetwork {
  return network === "facebook" || network === "threads" || network === "youtube";
}

/**
 * Live metrics of an account's latest posts in the range: fills acc.metrics /
 * metricsPosts / note and returns the metrics of each post by its external id.
 */
async function liveForAccount(workspaceId: string, acc: AccountStats, since: Date, now: Date): Promise<Map<string, Metrics>> {
  const perPost = new Map<string, Metrics>();
  const network = acc.network as LiveNetwork;
  try {
    const creds = await usableCredentials(workspaceId, acc.id, now);
    const posts = await prisma.channelPostTarget.findMany({
      where: { workspaceId, accountRef: acc.id, status: "PUBLISHED", publishedAt: { gte: since, lte: now } },
      orderBy: { publishedAt: "desc" },
      take: LIVE_POSTS_PER_ACCOUNT,
      select: { externalIds: true },
    });
    let sum: Metrics = EMPTY;
    let covered = 0;
    let lastError: unknown = null;
    for (const p of posts) {
      const id = p.externalIds[0];
      if (!id) continue;
      try {
        const m = addMetrics(EMPTY, await liveMetrics(network, creds, id, now.getTime()));
        perPost.set(id, m);
        sum = addMetrics(sum, m);
        covered += 1;
      } catch (error) {
        lastError = error;
        // A dead token fails every post the same way: stop early.
        if (error instanceof ChannelError && (error.kind === "auth" || error.kind === "rate_limit")) break;
      }
    }
    acc.metrics = covered ? sum : null;
    acc.metricsPosts = covered;
    if (!covered && lastError) acc.note = noteFor(lastError);
    else if (acc.published > covered && covered === LIVE_POSTS_PER_ACCOUNT) acc.note = `Oxirgi ${LIVE_POSTS_PER_ACCOUNT} ta post bo'yicha`;
  } catch (error) {
    acc.note = noteFor(error);
  }
  return perPost;
}

function totalsOf(accounts: AccountStats[]): NetworkStats["totals"] {
  return Object.fromEntries(
    STATS_NETWORKS.map((n) => {
      const rows = accounts.filter((a) => a.network === n);
      const withMetrics = rows.filter((a) => a.metrics);
      return [
        n,
        {
          accounts: rows.length,
          published: rows.reduce((s, a) => s + a.published, 0),
          failed: rows.reduce((s, a) => s + a.failed, 0),
          inbound: rows.reduce((s, a) => s + a.inbound, 0),
          replies: rows.reduce((s, a) => s + a.replies, 0),
          metrics: withMetrics.length ? withMetrics.reduce<Metrics>((m, a) => addMetrics(m, a.metrics!), EMPTY) : null,
        },
      ];
    })
  ) as NetworkStats["totals"];
}

// ─── One network in detail ─────────────────────────────────────────────────────

export type DetailNetwork = Exclude<StatsNetwork, "instagram">;
export const DETAIL_NETWORKS: DetailNetwork[] = ["facebook", "threads", "youtube", "telegram"];
/** Posts listed in the detail table (newest first). */
export const DETAIL_POSTS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const TASHKENT_MS = 5 * 60 * 60 * 1000;

export interface DetailPost {
  id: string;
  accountId: string;
  accountLabel: string;
  caption: string | null;
  status: "PUBLISHED" | "FAILED";
  publishedAt: string | null;
  failedAt: string | null;
  error: string | null;
  permalink: string | null;
  /** Null when not fetched: older than the latest few, Telegram, or the platform refused. */
  metrics: Metrics | null;
}

export interface DailyPoint {
  date: string;
  published: number;
  failed: number;
  inbound: number;
  replies: number;
}

export interface NetworkDetail {
  network: DetailNetwork;
  days: number;
  since: string;
  /** Every account of the network (the account picker), whatever the filter. */
  allAccounts: Array<{ id: string; label: string }>;
  accountId: string | null;
  accounts: AccountStats[];
  totals: NetworkStats["totals"][StatsNetwork];
  daily: DailyPoint[];
  posts: DetailPost[];
  postsTotal: number;
}

/** Calendar day in Tashkent (the product's home timezone). */
function dayKey(d: Date): string {
  return new Date(d.getTime() + TASHKENT_MS).toISOString().slice(0, 10);
}

export function permalinkOf(network: DetailNetwork, externalId: string | undefined, telegram?: { chatId: string; username: string | null }): string | null {
  if (!externalId) return null;
  if (network === "facebook") return `https://www.facebook.com/${encodeURIComponent(externalId)}`;
  if (network === "youtube") return `https://www.youtube.com/watch?v=${encodeURIComponent(externalId)}`;
  if (network === "telegram" && telegram) {
    const first = externalId.split(",")[0];
    if (!/^\d+$/.test(first)) return null;
    if (telegram.username && /^[A-Za-z0-9_]+$/.test(telegram.username)) return `https://t.me/${telegram.username}/${first}`;
    const internal = telegram.chatId.replace(/^-100/, "");
    return /^\d+$/.test(internal) ? `https://t.me/c/${internal}/${first}` : null;
  }
  // Threads media ids are not the URL shortcode and the permalink is not stored.
  return null;
}

export async function getNetworkDetail(
  workspaceId: string,
  network: DetailNetwork,
  opts: { days: number; accountId?: string | null; now?: Date; live?: boolean }
): Promise<NetworkDetail | null> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.days * DAY_MS);
  const base = await getNetworkStats(workspaceId, { days: opts.days, now, live: false });
  const all = base.accounts.filter((a) => a.network === network);
  const accountId = opts.accountId && all.some((a) => a.id === opts.accountId) ? opts.accountId : null;
  if (opts.accountId && !accountId) return null;
  const accounts = accountId ? all.filter((a) => a.id === accountId) : all;
  const refs = accounts.map((a) => a.id);

  const targetWhere = {
    workspaceId,
    channel: network,
    accountRef: { in: refs },
    status: { in: ["PUBLISHED", "FAILED"] as Array<"PUBLISHED" | "FAILED"> },
    OR: [{ publishedAt: { gte: since, lte: now } }, { status: "FAILED" as const, updatedAt: { gte: since, lte: now } }],
  };
  const [targets, messages, tgChannels] = await Promise.all([
    refs.length
      ? prisma.channelPostTarget.findMany({
          where: targetWhere,
          take: 5000,
          select: { id: true, accountRef: true, status: true, externalIds: true, publishedAt: true, updatedAt: true, lastError: true, post: { select: { caption: true } } },
        })
      : Promise.resolve([]),
    refs.length
      ? prisma.channelMessage.findMany({ where: { workspaceId, accountRef: { in: refs }, createdAt: { gte: since, lte: now } }, select: { createdAt: true, direction: true }, take: 20_000 })
      : Promise.resolve([]),
    network === "telegram" && refs.length ? prisma.telegramChannel.findMany({ where: { workspaceId, id: { in: refs } }, select: { id: true, chatId: true, username: true } }) : Promise.resolve([]),
  ]);

  // Live metrics: the same latest-posts window and cache as the overview.
  const perPost = new Map<string, Metrics>();
  if ((opts.live ?? true) && isLive(network)) {
    await Promise.all(
      accounts
        .filter((a) => a.published > 0 && !a.note)
        .map(async (acc) => {
          for (const [id, m] of await liveForAccount(workspaceId, acc, since, now)) perPost.set(id, m);
        })
    );
  }

  // One point per day of the range, zero-filled so the chart has no gaps.
  const daily = new Map<string, DailyPoint>();
  for (let t = since.getTime(); t < now.getTime() + DAY_MS; t += DAY_MS) {
    const key = dayKey(new Date(Math.min(t, now.getTime())));
    if (!daily.has(key)) daily.set(key, { date: key, published: 0, failed: 0, inbound: 0, replies: 0 });
  }
  const at = (t: (typeof targets)[number]) => (t.status === "PUBLISHED" ? t.publishedAt : t.updatedAt) ?? t.updatedAt;
  for (const t of targets) {
    const point = daily.get(dayKey(at(t)));
    if (point) point[t.status === "PUBLISHED" ? "published" : "failed"] += 1;
  }
  for (const m of messages) {
    const point = daily.get(dayKey(m.createdAt));
    if (point) point[m.direction === "IN" ? "inbound" : "replies"] += 1;
  }

  const label = new Map(accounts.map((a) => [a.id, a.label]));
  const tg = new Map(tgChannels.map((c) => [c.id, c]));
  const posts: DetailPost[] = [...targets]
    .sort((a, b) => at(b).getTime() - at(a).getTime())
    .slice(0, DETAIL_POSTS)
    .map((t) => ({
      id: t.id,
      accountId: t.accountRef,
      accountLabel: label.get(t.accountRef) ?? "",
      caption: t.post?.caption?.trim() || null,
      status: t.status as "PUBLISHED" | "FAILED",
      publishedAt: t.publishedAt?.toISOString() ?? null,
      failedAt: t.status === "FAILED" ? t.updatedAt.toISOString() : null,
      error: t.status === "FAILED" ? t.lastError : null,
      permalink: t.status === "PUBLISHED" ? permalinkOf(network, t.externalIds[0], tg.get(t.accountRef)) : null,
      metrics: (t.externalIds[0] && perPost.get(t.externalIds[0])) || null,
    }));

  return {
    network,
    days: opts.days,
    since: since.toISOString(),
    allAccounts: all.map((a) => ({ id: a.id, label: a.label })),
    accountId,
    accounts,
    totals: totalsOf(accounts)[network],
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    posts,
    postsTotal: targets.length,
  };
}
