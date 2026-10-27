/**
 * YouTube adapter (audit 2026-10-26, T6), YouTube Data API v3 over Google
 * OAuth:
 *
 *   externalAccountId   channel id (UC…)
 *   accessToken         1-hour token; lib/channels/access.ts refreshes it
 *                       before a call when it is about to expire
 *   refreshToken        long-lived (access_type=offline, prompt=consent)
 *   extra.title, extra.tenantId
 *
 * Publish: resumable upload (videos.insert, 1600 quota units), then Google
 * processes the video, so publish returns "processing" and continuePublish
 * reads uploadStatus. A Short is a vertical video ≤ 3 min; "#Shorts" in the
 * title makes sure YouTube files it there.
 *
 * Quota: the project has 10 000 units a day (YOUTUBE_QUOTA_UNITS), shared by
 * every tenant, reset at midnight Pacific. Every call is counted in Redis
 * first; an exhausted day is a rate_limit with the seconds to the reset, so
 * the cross-post sweep moves the target to the next day instead of failing.
 *
 * No comment webhooks: pollYoutubeComments reads new comment threads since
 * the credential's pollCursor (1 unit a call). No DMs on YouTube.
 *
 * Until Google verifies the app (audit: owner, phase 9), uploads from an
 * unverified project are forced to private by YouTube.
 */

import { getRedisConnection } from "@/lib/queue/client";
import { googleError, googleJson, googleUploadSession, secondsToPacificMidnight } from "./api";
import { capabilitiesOf } from "./capabilities";
import { ChannelError, type ChannelAdapter, type ChannelCredentials, type InboundEvent, type PostVariant, type PublishResult } from "./types";

const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
];

/** Quota cost of each call we make (YouTube Data API quota table). */
export const YOUTUBE_COST = { upload: 1600, list: 1, commentInsert: 50, moderate: 50 } as const;
export const DEFAULT_YOUTUBE_QUOTA_UNITS = 10_000;
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;

// ─── Quota ─────────────────────────────────────────────────────────────────────

export function pacificDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Reserve quota units for today's Pacific day; over the cap → rate_limit until the reset. */
export async function consumeYoutubeQuota(units: number, now = new Date()): Promise<void> {
  const cap = Number(process.env.YOUTUBE_QUOTA_UNITS) || DEFAULT_YOUTUBE_QUOTA_UNITS;
  const key = `yt:quota:${pacificDay(now)}`;
  try {
    const redis = getRedisConnection();
    const used = await redis.incrby(key, units);
    if (used === units) await redis.expire(key, 2 * 86_400);
    if (used > cap) {
      await redis.decrby(key, units);
      throw new ChannelError("rate_limit", "YouTube kunlik kvotasi tugadi", secondsToPacificMidnight(now));
    }
  } catch (error) {
    if (error instanceof ChannelError) throw error;
    // Redis down: let Google's own quota answer decide.
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function ctx(creds: ChannelCredentials) {
  if (!creds.externalAccountId || !creds.accessToken) throw new ChannelError("auth", "YouTube kanal ulanmagan");
  const tenantId = typeof creds.extra?.tenantId === "string" ? creds.extra.tenantId : null;
  return { channelId: creds.externalAccountId, headers: { Authorization: `Bearer ${creds.accessToken}` }, tenantId };
}

const api = (path: string, params: Record<string, string>) => `${API}/${path}?${new URLSearchParams(params)}`;

/** Title / description from the post: title = options.title or the caption's first line. */
export function youtubeMetadata(post: PostVariant): { title: string; description: string } {
  const text = (post.text ?? "").trim();
  const clean = (s: string) => s.replace(/[<>]/g, "").trim();
  let title = clean(typeof post.options?.title === "string" ? post.options.title : text.split("\n")[0] ?? "");
  if (!title) title = "Video";
  if (post.format === "short" && !/#shorts\b/i.test(title)) {
    title = `${title.slice(0, YOUTUBE_TITLE_MAX - 8).trim()} #Shorts`;
  }
  if (title.length > YOUTUBE_TITLE_MAX) title = `${title.slice(0, YOUTUBE_TITLE_MAX - 1).trim()}…`;
  return { title, description: clean(text).slice(0, YOUTUBE_DESCRIPTION_MAX) };
}

const PRIVACY = new Set(["public", "unlisted", "private"]);

export const youtubeAdapter: ChannelAdapter = {
  channel: "youtube",
  capabilities: () => capabilitiesOf("youtube"),

  async connect(creds) {
    const { headers, tenantId } = ctx(creds);
    await consumeYoutubeQuota(YOUTUBE_COST.list);
    const data = await googleJson<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>(api("channels", { part: "snippet", mine: "true" }), { headers, tenantId });
    const channel = data.items?.[0];
    if (!channel) throw new ChannelError("permission", "Bu Google akkauntida YouTube kanal yo'q");
    return { externalAccountId: channel.id, username: channel.snippet?.title ?? null };
  },

  async refreshCredentials(creds) {
    if (!creds.refreshToken) throw new ChannelError("auth", "YouTube refresh token yo'q — qayta ulang");
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
    const secret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
    if (!clientId || !secret) throw new ChannelError("invalid", "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET sozlanmagan");
    const token = await googleJson<{ access_token: string; expires_in?: number; refresh_token?: string }>(TOKEN_URL, {
      form: { client_id: clientId, client_secret: secret, refresh_token: creds.refreshToken, grant_type: "refresh_token" },
    });
    return { accessToken: token.access_token, refreshToken: token.refresh_token ?? creds.refreshToken, expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000) };
  },

  async checkCredentials(creds) {
    try {
      const fresh = await this.refreshCredentials(creds);
      await this.connect({ ...creds, accessToken: fresh.accessToken });
      return { ok: true };
    } catch (error) {
      if (error instanceof ChannelError && (error.kind === "auth" || error.kind === "permission")) return { ok: false, error: "auth" };
      return { ok: false, error: error instanceof Error ? error.message : "check failed" };
    }
  },

  async publish(creds, post): Promise<PublishResult> {
    const { headers, tenantId } = ctx(creds);
    if (post.format !== "video" && post.format !== "short" && post.format !== "reel") throw new ChannelError("not_supported", "YouTube'ga faqat video chiqadi");
    const source = post.mediaUrls?.[0];
    if (!source || (post.mediaUrls?.length ?? 0) > 1) throw new ChannelError("invalid", "YouTube uchun bitta video kerak");
    const media = await fetch(source, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) }).catch(() => null);
    if (!media?.ok || !media.body) throw new ChannelError("transient", "Video faylni o'qib bo'lmadi");
    const contentType = media.headers.get("content-type") || "video/mp4";
    const length = media.headers.get("content-length");

    const { title, description } = youtubeMetadata(post.format === "reel" ? { ...post, format: "short" } : post);
    const privacy = typeof post.options?.privacyStatus === "string" && PRIVACY.has(post.options.privacyStatus) ? post.options.privacyStatus : "public";
    await consumeYoutubeQuota(YOUTUBE_COST.upload);
    const session = await googleUploadSession(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: { ...headers, "X-Upload-Content-Type": contentType, ...(length ? { "X-Upload-Content-Length": length } : {}) },
      body: { snippet: { title, description, categoryId: "22" }, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } },
      tenantId,
    });

    // The bytes go straight from storage to Google (no buffering); a stream
    // cannot be retried, so this is one plain fetch with a long timeout.
    const put = await fetch(session, {
      method: "PUT",
      headers: { ...headers, "Content-Type": contentType, ...(length ? { "Content-Length": length } : {}) },
      body: media.body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      // Node needs this for a streamed request body.
      ...({ duplex: "half" } as object),
    }).catch(() => null);
    if (!put) throw new ChannelError("transient", "YouTube'ga yuklash uzildi");
    const body = (await put.json().catch(() => ({}))) as { id?: string };
    if (put.status >= 400) throw googleError(put.status, body as Parameters<typeof googleError>[1]);
    if (!body.id) throw new ChannelError("transient", "YouTube video id qaytarmadi");
    return { status: "processing", pollToken: `video:${body.id}`, retryAfterSec: 60 };
  },

  async continuePublish(creds, pollToken) {
    const { headers, tenantId } = ctx(creds);
    const id = pollToken.replace(/^video:/, "");
    await consumeYoutubeQuota(YOUTUBE_COST.list);
    const data = await googleJson<{ items?: Array<{ status?: { uploadStatus?: string; failureReason?: string; rejectionReason?: string } }> }>(api("videos", { part: "status", id }), { headers, tenantId });
    const status = data.items?.[0]?.status;
    if (!status) throw new ChannelError("invalid", "YouTube videoni topmadi (o'chirilgan bo'lishi mumkin)");
    if (status.uploadStatus === "processed") return { status: "published", externalId: id, permalink: `https://www.youtube.com/watch?v=${id}` };
    if (status.uploadStatus === "failed" || status.uploadStatus === "rejected" || status.uploadStatus === "deleted") {
      throw new ChannelError("invalid", `YouTube videoni qabul qilmadi: ${status.rejectionReason ?? status.failureReason ?? status.uploadStatus}`);
    }
    return { status: "processing", pollToken, retryAfterSec: 60 };
  },

  async replyComment(creds, commentId, text) {
    const { headers, tenantId } = ctx(creds);
    await consumeYoutubeQuota(YOUTUBE_COST.commentInsert);
    const created = await googleJson<{ id: string }>(api("comments", { part: "snippet" }), { headers, tenantId, body: { snippet: { parentId: commentId, textOriginal: text } } });
    return { externalId: created.id };
  },

  // "heldForReview" takes the comment out of public view; "published" brings it back.
  async hideComment(creds, commentId, hide) {
    const { headers, tenantId } = ctx(creds);
    await consumeYoutubeQuota(YOUTUBE_COST.moderate);
    await googleJson(api("comments/setModerationStatus", { id: commentId, moderationStatus: hide ? "heldForReview" : "published" }), { method: "POST", headers, tenantId });
  },

  async sendDm() {
    throw new ChannelError("not_supported", "YouTube'da shaxsiy xabar yo'q");
  },

  async privateReply() {
    throw new ChannelError("not_supported", "YouTube'da shaxsiy javob yo'q");
  },

  async fetchInsights(creds, mediaId) {
    const { headers, tenantId } = ctx(creds);
    await consumeYoutubeQuota(YOUTUBE_COST.list);
    const data = await googleJson<{ items?: Array<{ statistics?: Record<string, string> }> }>(api("videos", { part: "statistics", id: mediaId }), { headers, tenantId });
    const stats = data.items?.[0]?.statistics ?? {};
    const out: Record<string, number> = {};
    for (const [key, name] of [["viewCount", "views"], ["likeCount", "likes"], ["commentCount", "comments"], ["favoriteCount", "favorites"]] as const) {
      if (stats[key] !== undefined) out[name] = Number(stats[key]);
    }
    return { externalId: mediaId, metrics: out, fetchedAt: new Date() };
  },
};

// ─── Comment polling ───────────────────────────────────────────────────────────

interface CommentThread {
  id: string;
  snippet?: {
    videoId?: string;
    topLevelComment?: { id: string; snippet?: { authorDisplayName?: string; authorChannelId?: { value?: string }; textDisplay?: string; textOriginal?: string; publishedAt?: string } };
  };
}

/** New top-level comments on the channel's videos since `since`, oldest first. */
export async function pollYoutubeComments(creds: ChannelCredentials, since: Date | null): Promise<InboundEvent[]> {
  const { channelId, headers, tenantId } = ctx(creds);
  const events: InboundEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page++) {
    await consumeYoutubeQuota(YOUTUBE_COST.list);
    const data = await googleJson<{ items?: CommentThread[]; nextPageToken?: string }>(
      api("commentThreads", { part: "snippet", allThreadsRelatedToChannelId: channelId, order: "time", maxResults: "50", textFormat: "plainText", ...(pageToken ? { pageToken } : {}) }),
      { headers, tenantId }
    );
    let reachedOld = false;
    for (const thread of data.items ?? []) {
      const top = thread.snippet?.topLevelComment;
      const at = top?.snippet?.publishedAt ? new Date(top.snippet.publishedAt) : null;
      if (!top || !at) continue;
      if (since && at <= since) {
        reachedOld = true;
        break;
      }
      const author = top.snippet?.authorChannelId?.value ?? "";
      if (author === channelId) continue;
      events.push({
        tenantId,
        channel: "youtube",
        accountId: channelId,
        kind: "comment",
        externalId: top.id,
        threadId: thread.snippet?.videoId ?? null,
        author: { externalId: author, name: top.snippet?.authorDisplayName ?? null },
        text: top.snippet?.textOriginal ?? top.snippet?.textDisplay ?? "",
        media: [],
        createdAt: at,
        rawRef: null,
      });
    }
    // First run: only the newest page, no backfill of years of comments.
    if (reachedOld || !since || !data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return events.reverse();
}

// ─── OAuth: Google ─────────────────────────────────────────────────────────────

export function youtubeAuthorizeUrl(redirectUri: string, state: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) throw new ChannelError("invalid", "GOOGLE_CLIENT_ID sozlanmagan");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
  // offline + consent: Google returns a refresh token every time, also on a reconnect.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function youtubeTokenFromCode(code: string, redirectUri: string): Promise<{ channelId: string; title: string | null; accessToken: string; refreshToken: string; expiresAt: Date; scopes: string[] }> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !secret) throw new ChannelError("invalid", "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET sozlanmagan");
  const token = await googleJson<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>(TOKEN_URL, {
    form: { client_id: clientId, client_secret: secret, code, redirect_uri: redirectUri, grant_type: "authorization_code" },
  });
  if (!token.refresh_token) throw new ChannelError("auth", "Google refresh token bermadi — ruxsatni qayta bering");
  const me = await youtubeAdapter.connect({ accessToken: token.access_token, externalAccountId: "pending" });
  return {
    channelId: me.externalAccountId,
    title: me.username,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000),
    scopes: (token.scope ?? "").split(" ").filter(Boolean),
  };
}
