/**
 * Facebook Page adapter (audit 2026-10-26, T4). Credentials: a Page access
 * token (from a long-lived user token, so it does not expire, but a password
 * or permission change kills it: the daily pass runs debug_token).
 *
 *   externalAccountId   Page id
 *   extra.pageName      for the panel
 *   extra.tenantId      the workspace, for the per-tenant API cap
 *
 * Publish: text (/feed), photo (/photos), several photos (unpublished photos
 * attached to one /feed post), video (/videos by file_url) and Reels (the
 * three-step video_reels upload: start → rupload transfer → finish; Meta then
 * processes it, so it returns "processing" and continuePublish polls).
 *
 * Private replies (once per comment, 7 days) and the Messenger 24-hour
 * window are policy, enforced in lib/channels/policy.ts before this adapter
 * is called. Reels count against FACEBOOK_REELS_DAILY_LIMIT in the sweep.
 */

import { getMetaGraphApiVersion } from "@/lib/env";
import { metaJson } from "./api";
import { capabilitiesOf } from "./capabilities";
import { facebookChannelsApp } from "./meta-app";
import { ChannelError, type ChannelAdapter, type ChannelCredentials, type InboundEvent, type PostVariant, type PublishResult } from "./types";

const LABEL = "Facebook";

export function facebookGraph(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://graph.facebook.com/${getMetaGraphApiVersion()}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function ctx(creds: ChannelCredentials) {
  if (!creds.externalAccountId || !creds.accessToken) throw new ChannelError("auth", "Facebook sahifa ulanmagan");
  const tenantId = typeof creds.extra?.tenantId === "string" ? creds.extra.tenantId : null;
  return { page: creds.externalAccountId, token: creds.accessToken, tenantId };
}

export const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_posts",
  "pages_manage_engagement",
  "pages_manage_metadata",
  "pages_messaging",
  "read_insights",
];

/** Scopes plain Facebook Login accepts today: read_insights is not enabled for the app, and Meta rejects the whole dialog on an invalid scope. */
export const FACEBOOK_CLASSIC_SCOPES = FACEBOOK_SCOPES.filter((scope) => scope !== "read_insights");

/** Reels publishing through the API: 30 a Page per 24 h (audit, Meta Reels guide). */
export const FACEBOOK_REELS_DAILY_LIMIT = 30;

const isVideo = (post: PostVariant, url: string, i: number) => {
  const kinds = post.options?.kinds;
  if (Array.isArray(kinds) && kinds[i]) return kinds[i] === "video";
  return /\.(mp4|mov|m4v)(\?|$)/i.test(url);
};

async function startReel(page: string, token: string, tenantId: string | null, post: PostVariant): Promise<PublishResult> {
  const url = post.mediaUrls?.[0];
  if (!url) throw new ChannelError("invalid", "Reels uchun video kerak");
  const start = await metaJson<{ video_id: string; upload_url?: string }>(facebookGraph(`${page}/video_reels`), LABEL, {
    form: { upload_phase: "start", access_token: token },
    tenantId,
  });
  await metaJson<{ success?: boolean }>(`https://rupload.facebook.com/video-upload/${getMetaGraphApiVersion()}/${start.video_id}`, LABEL, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, file_url: url },
    tenantId,
    timeoutMs: 120_000,
  });
  await metaJson<{ success?: boolean }>(facebookGraph(`${page}/video_reels`), LABEL, {
    form: { upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description: post.text ?? "", access_token: token },
    tenantId,
  });
  return { status: "processing", pollToken: `reel:${start.video_id}`, retryAfterSec: 30 };
}

export const facebookAdapter: ChannelAdapter = {
  channel: "facebook",
  capabilities: () => capabilitiesOf("facebook"),

  async connect(creds) {
    const { token, tenantId } = ctx(creds);
    const me = await metaJson<{ id: string; name?: string }>(facebookGraph("me", { fields: "id,name", access_token: token }), LABEL, { tenantId });
    return { externalAccountId: me.id, username: me.name ?? null };
  },

  // Page tokens from a long-lived user token do not expire.
  async refreshCredentials(creds) {
    return { accessToken: creds.accessToken, refreshToken: creds.refreshToken ?? null, expiresAt: null };
  },

  async checkCredentials(creds) {
    const { token, tenantId } = ctx(creds);
    const { appId, secret } = facebookChannelsApp();
    try {
      if (appId && secret) {
        const debug = await metaJson<{ data?: { is_valid?: boolean } }>(facebookGraph("debug_token", { input_token: token, access_token: `${appId}|${secret}` }), LABEL, { tenantId });
        return debug.data?.is_valid ? { ok: true } : { ok: false, error: "auth" };
      }
      await metaJson(facebookGraph("me", { fields: "id", access_token: token }), LABEL, { tenantId });
      return { ok: true };
    } catch (error) {
      if (error instanceof ChannelError && (error.kind === "auth" || error.kind === "permission")) return { ok: false, error: "auth" };
      return { ok: false, error: error instanceof Error ? error.message : "check failed" };
    }
  },

  async publish(creds, post) {
    const { page, token, tenantId } = ctx(creds);
    const text = post.text ?? "";
    const urls = post.mediaUrls ?? [];
    if (post.format === "reel") return startReel(page, token, tenantId, post);
    if (post.format === "text" || urls.length === 0) {
      if (!text.trim()) throw new ChannelError("invalid", "Bo'sh post");
      const created = await metaJson<{ id: string }>(facebookGraph(`${page}/feed`), LABEL, { form: { message: text, access_token: token }, tenantId, idempotencyKey: post.idempotencyKey });
      return { status: "published", externalId: created.id, permalink: `https://www.facebook.com/${created.id}` };
    }
    if (urls.length === 1 && isVideo(post, urls[0], 0)) {
      const created = await metaJson<{ id: string }>(facebookGraph(`${page}/videos`), LABEL, {
        form: { file_url: urls[0], description: text, access_token: token },
        tenantId,
        timeoutMs: 120_000,
      });
      return { status: "published", externalId: created.id, permalink: `https://www.facebook.com/${page}/videos/${created.id}` };
    }
    if (urls.length === 1) {
      const created = await metaJson<{ id: string; post_id?: string }>(facebookGraph(`${page}/photos`), LABEL, { form: { url: urls[0], caption: text, access_token: token }, tenantId });
      const id = created.post_id ?? created.id;
      return { status: "published", externalId: id, permalink: `https://www.facebook.com/${id}` };
    }
    if (urls.some((url, i) => isVideo(post, url, i))) throw new ChannelError("not_supported", "Facebook'da video aralash albom API orqali chiqmaydi");
    const photoIds: string[] = [];
    for (const url of urls.slice(0, 10)) {
      const photo = await metaJson<{ id: string }>(facebookGraph(`${page}/photos`), LABEL, { form: { url, published: "false", access_token: token }, tenantId });
      photoIds.push(photo.id);
    }
    const form: Record<string, string> = { message: text, access_token: token };
    photoIds.forEach((id, i) => (form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
    const created = await metaJson<{ id: string }>(facebookGraph(`${page}/feed`), LABEL, { form, tenantId });
    return { status: "published", externalId: created.id, permalink: `https://www.facebook.com/${created.id}` };
  },

  async continuePublish(creds, pollToken) {
    const { token, tenantId } = ctx(creds);
    const videoId = pollToken.replace(/^reel:/, "");
    const video = await metaJson<{ status?: { video_status?: string; processing_phase?: { status?: string }; publishing_phase?: { status?: string } } }>(
      facebookGraph(videoId, { fields: "status", access_token: token }),
      LABEL,
      { tenantId }
    );
    const status = video.status;
    if (status?.video_status === "error" || status?.processing_phase?.status === "error" || status?.publishing_phase?.status === "error") {
      throw new ChannelError("invalid", "Facebook Reels'ni qayta ishlay olmadi");
    }
    if (status?.publishing_phase?.status === "complete" || status?.video_status === "ready") {
      return { status: "published", externalId: videoId, permalink: `https://www.facebook.com/reel/${videoId}` };
    }
    return { status: "processing", pollToken, retryAfterSec: 30 };
  },

  async replyComment(creds, commentId, text) {
    const { token, tenantId } = ctx(creds);
    const created = await metaJson<{ id: string }>(facebookGraph(`${commentId}/comments`), LABEL, { form: { message: text, access_token: token }, tenantId });
    return { externalId: created.id };
  },

  async hideComment(creds, commentId, hide) {
    const { token, tenantId } = ctx(creds);
    await metaJson(facebookGraph(commentId), LABEL, { form: { is_hidden: String(hide), access_token: token }, tenantId });
  },

  async sendDm(creds, recipientId, text) {
    const { page, token, tenantId } = ctx(creds);
    const sent = await metaJson<{ message_id: string }>(facebookGraph(`${page}/messages`, { access_token: token }), LABEL, {
      body: { recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text } },
      tenantId,
    });
    return { externalId: sent.message_id };
  },

  async privateReply(creds, commentId, text) {
    const { page, token, tenantId } = ctx(creds);
    const sent = await metaJson<{ message_id: string }>(facebookGraph(`${page}/messages`, { access_token: token }), LABEL, {
      body: { recipient: { comment_id: commentId }, message: { text } },
      tenantId,
    });
    return { externalId: sent.message_id };
  },

  async fetchInsights(creds, mediaId, metrics) {
    const { token, tenantId } = ctx(creds);
    const list = metrics.length ? metrics : ["post_impressions_unique", "post_clicks", "post_reactions_by_type_total"];
    const data = await metaJson<{ data?: Array<{ name: string; values?: Array<{ value: unknown }> }> }>(
      facebookGraph(`${mediaId}/insights`, { metric: list.join(","), access_token: token }),
      LABEL,
      { tenantId }
    );
    const out: Record<string, number> = {};
    for (const row of data.data ?? []) {
      const value = row.values?.[0]?.value;
      if (typeof value === "number") out[row.name] = value;
      else if (value && typeof value === "object") out[row.name] = Object.values(value as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0);
    }
    return { externalId: mediaId, metrics: out, fetchedAt: new Date() };
  },
};

// ─── OAuth: Facebook Login for Business ────────────────────────────────────────

/** `classic` skips the Login for Business configuration and asks for the scopes directly (plain Facebook Login). */
export function facebookAuthorizeUrl(redirectUri: string, state: string, options: { classic?: boolean } = {}): string {
  const { appId } = facebookChannelsApp();
  const configId = options.classic ? undefined : process.env.FACEBOOK_LOGIN_CONFIG_ID?.trim();
  if (!appId) throw new ChannelError("invalid", "FACEBOOK_CHANNELS_APP_ID sozlanmagan");
  const url = new URL(`https://www.facebook.com/${getMetaGraphApiVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (configId) {
    url.searchParams.set("config_id", configId);
    url.searchParams.set("override_default_response_type", "true");
  } else {
    url.searchParams.set("scope", (options.classic ? FACEBOOK_CLASSIC_SCOPES : FACEBOOK_SCOPES).join(","));
  }
  return url.toString();
}

export interface FacebookPageChoice {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
}

/** code → short user token → long-lived user token → the Pages it manages, with their tokens. */
export async function facebookPagesFromCode(code: string, redirectUri: string): Promise<FacebookPageChoice[]> {
  const { appId, secret } = facebookChannelsApp();
  if (!appId || !secret) throw new ChannelError("invalid", "FACEBOOK_CHANNELS_APP_ID / FACEBOOK_CHANNELS_APP_SECRET sozlanmagan");
  const short = await metaJson<{ access_token: string }>(facebookGraph("oauth/access_token", { client_id: appId, client_secret: secret, redirect_uri: redirectUri, code }), LABEL);
  const long = await metaJson<{ access_token: string }>(
    facebookGraph("oauth/access_token", { grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: short.access_token }),
    LABEL
  );
  const fromLong = await pagesOf(long.access_token, appId, secret);
  if (fromLong.length > 0) return fromLong;
  // The exchange to a long-lived token may drop what the dialog granted: ask with the short token too,
  // then re-read each Page with the long one so the Page tokens do not expire with the short token.
  const fromShort = await pagesOf(short.access_token, appId, secret);
  // Ids, counts and task names only: enough to tell why Meta returned no Page, no token.
  console.warn(`[facebook] no Page with the long token; short token found ${fromShort.length}: ${fromShort.map((p) => `${p.id}[${p.tasks.join(",")}]`).join(" ") || "none"}`);
  const upgraded = await Promise.all(fromShort.map(async (p) => (await pageById(p.id, long.access_token)) ?? p));
  return upgraded;
}

/** Pages a user token can manage: me/accounts, then the Pages named by its granular scopes. */
async function pagesOf(userToken: string, appId: string, secret: string): Promise<FacebookPageChoice[]> {
  const pages = await metaJson<{ data?: Array<{ id: string; name: string; access_token: string; tasks?: string[] }> }>(
    facebookGraph("me/accounts", { fields: "id,name,access_token,tasks", limit: "100", access_token: userToken }),
    LABEL
  );
  const listed = (pages.data ?? []).map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token, tasks: p.tasks ?? [] }));
  if (listed.length > 0) return listed;
  return pagesFromGrantedScopes(userToken, appId, secret);
}

async function pageById(id: string, userToken: string): Promise<FacebookPageChoice | null> {
  const page = await metaJson<{ id: string; name?: string; access_token?: string; tasks?: string[] }>(
    facebookGraph(id, { fields: "id,name,access_token,tasks", access_token: userToken }),
    LABEL
  ).catch((error) => {
    // Message only (Meta error text, no token): shows why a granted Page could not be read.
    console.warn(`[facebook] Page ${id} could not be read: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    return null;
  });
  if (page && !page.access_token) console.warn(`[facebook] Page ${id} came back without an access_token (tasks: ${(page.tasks ?? []).join(",") || "none"})`);
  return page?.access_token ? { id: page.id, name: page.name ?? page.id, accessToken: page.access_token, tasks: page.tasks ?? [] } : null;
}

/**
 * Facebook Login for Business can return an empty `me/accounts` even though the
 * user picked Pages in the dialog: the picked Pages are only listed as target ids
 * of the token's granular scopes. Read them from debug_token and fetch each Page.
 */
async function pagesFromGrantedScopes(userToken: string, appId: string, secret: string): Promise<FacebookPageChoice[]> {
  const debug = await metaJson<{ data?: { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> } }>(
    facebookGraph("debug_token", { input_token: userToken, access_token: `${appId}|${secret}` }),
    LABEL
  );
  const ids = new Set<string>();
  for (const granted of debug.data?.granular_scopes ?? []) {
    if (granted.scope.startsWith("pages_")) for (const id of granted.target_ids ?? []) ids.add(id);
  }
  console.warn(`[facebook] debug_token granular scopes: ${(debug.data?.granular_scopes ?? []).map((g) => `${g.scope}=${(g.target_ids ?? []).length}`).join(" ") || "none"}`);
  const found: FacebookPageChoice[] = [];
  for (const id of ids) {
    const page = await pageById(id, userToken);
    if (page) found.push(page);
  }
  return found;
}

/** Webhooks for the Page: comments (feed) and Messenger (messages). */
export async function subscribePage(pageId: string, pageToken: string): Promise<void> {
  await metaJson(facebookGraph(`${pageId}/subscribed_apps`), LABEL, { form: { subscribed_fields: "feed,messages", access_token: pageToken } });
}

// ─── Webhook ───────────────────────────────────────────────────────────────────

interface PageFeedValue {
  item?: string;
  verb?: string;
  comment_id?: string;
  post_id?: string;
  parent_id?: string;
  message?: string;
  created_time?: number | string;
  from?: { id?: string; name?: string };
}

interface PageMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: Array<{ type?: string; payload?: { url?: string } }> };
  postback?: { mid?: string; title?: string; payload?: string };
}

const MEDIA_TYPES = new Set(["image", "video", "audio", "file", "sticker"]);

function feedTime(value: number | string | undefined): Date {
  if (typeof value === "number") return new Date(value * 1000);
  if (typeof value === "string" && value) return new Date(/^\d+$/.test(value) ? Number(value) * 1000 : value);
  return new Date();
}

/**
 * Page webhooks (object "page"): new comments from `feed` changes and
 * Messenger messages / postbacks. The Page's own comments, edits, removals
 * and message echoes are not events for us.
 */
export function normalizeFacebookWebhook(payload: unknown, rawRef: string | null = null): InboundEvent[] {
  if (!payload || typeof payload !== "object" || (payload as { object?: string }).object !== "page") return [];
  const events: InboundEvent[] = [];
  for (const entry of (payload as { entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: PageFeedValue }>; messaging?: PageMessaging[] }> }).entry ?? []) {
    const page = entry.id;
    if (!page) continue;
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (change.field !== "feed" || value?.item !== "comment" || value.verb !== "add" || !value.comment_id) continue;
      if (value.from?.id === page) continue;
      const isReply = Boolean(value.parent_id && value.parent_id !== value.post_id);
      events.push({
        tenantId: null,
        channel: "facebook",
        accountId: page,
        kind: isReply ? "reply" : "comment",
        externalId: value.comment_id,
        threadId: value.post_id ?? null,
        author: { externalId: value.from?.id ?? "", name: value.from?.name ?? null },
        text: value.message ?? "",
        media: [],
        createdAt: feedTime(value.created_time),
        rawRef,
        parentId: value.parent_id ?? null,
      });
    }
    for (const item of entry.messaging ?? []) {
      const sender = item.sender?.id;
      if (!sender || sender === page || item.message?.is_echo) continue;
      if (item.message?.mid) {
        events.push({
          tenantId: null,
          channel: "facebook",
          accountId: page,
          kind: "dm",
          externalId: item.message.mid,
          threadId: sender,
          author: { externalId: sender },
          text: item.message.text ?? "",
          media: (item.message.attachments ?? []).map((a) => ({ type: (MEDIA_TYPES.has(a.type ?? "") ? a.type : "other") as InboundEvent["media"][number]["type"], url: a.payload?.url ?? null })),
          createdAt: item.timestamp ? new Date(item.timestamp) : new Date(),
          rawRef,
        });
      } else if (item.postback) {
        events.push({
          tenantId: null,
          channel: "facebook",
          accountId: page,
          kind: "postback",
          externalId: item.postback.mid ?? `pb:${sender}:${item.timestamp ?? Date.now()}`,
          threadId: sender,
          author: { externalId: sender },
          text: item.postback.title ?? item.postback.payload ?? "",
          media: [],
          createdAt: item.timestamp ? new Date(item.timestamp) : new Date(),
          rawRef,
        });
      }
    }
  }
  return events;
}
