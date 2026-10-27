/**
 * Threads adapter (audit 2026-10-26, T5). Threads has its own login and
 * Graph host (graph.threads.net), separate from Facebook / Instagram:
 *
 *   externalAccountId   Threads user id
 *   accessToken         long-lived token (60 days; the daily pass refreshes it
 *                       10 days before expiry with th_refresh_token)
 *   extra.username, extra.tenantId
 *
 * Publish is two steps, like Instagram: create a container, then
 * threads_publish. Text publishes at once; image / video / carousel
 * containers are processed by Meta first, so publish returns "processing" and
 * continuePublish checks the container status (FINISHED → publish).
 * No DMs on Threads; replies and hide go through manage_reply.
 */

import { metaJson } from "./api";
import { capabilitiesOf } from "./capabilities";
import { ChannelError, type ChannelAdapter, type ChannelCredentials, type InboundEvent, type PostVariant, type PublishResult } from "./types";

const LABEL = "Threads";
const HOST = "https://graph.threads.net";
const VERSION = "v1.0";
export const THREADS_TEXT_LIMIT = 500;
export const THREADS_CAROUSEL_MAX = 20;

export const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_read_replies", "threads_manage_insights"];

export function threadsGraph(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`${HOST}/${VERSION}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function ctx(creds: ChannelCredentials) {
  if (!creds.externalAccountId || !creds.accessToken) throw new ChannelError("auth", "Threads akkaunti ulanmagan");
  const tenantId = typeof creds.extra?.tenantId === "string" ? creds.extra.tenantId : null;
  return { user: creds.externalAccountId, token: creds.accessToken, tenantId };
}

const isVideo = (post: PostVariant, url: string, i: number) => {
  const kinds = post.options?.kinds;
  if (Array.isArray(kinds) && kinds[i]) return kinds[i] === "video";
  return /\.(mp4|mov|m4v)(\?|$)/i.test(url);
};

async function container(user: string, token: string, tenantId: string | null, fields: Record<string, string>): Promise<string> {
  const created = await metaJson<{ id: string }>(threadsGraph(`${user}/threads`), LABEL, { form: { ...fields, access_token: token }, tenantId });
  return created.id;
}

async function publishContainer(user: string, token: string, tenantId: string | null, creationId: string): Promise<PublishResult> {
  const media = await metaJson<{ id: string }>(threadsGraph(`${user}/threads_publish`), LABEL, { form: { creation_id: creationId, access_token: token }, tenantId });
  const info = await metaJson<{ permalink?: string }>(threadsGraph(media.id, { fields: "permalink", access_token: token }), LABEL, { tenantId }).catch(() => ({ permalink: undefined }));
  return { status: "published", externalId: media.id, permalink: info.permalink ?? null };
}

export const threadsAdapter: ChannelAdapter = {
  channel: "threads",
  capabilities: () => capabilitiesOf("threads"),

  async connect(creds) {
    const { token, tenantId } = ctx(creds);
    const me = await metaJson<{ id: string; username?: string }>(threadsGraph("me", { fields: "id,username", access_token: token }), LABEL, { tenantId });
    return { externalAccountId: me.id, username: me.username ?? null };
  },

  async refreshCredentials(creds) {
    const { token, tenantId } = ctx(creds);
    const next = await metaJson<{ access_token: string; expires_in?: number }>(
      `${HOST}/refresh_access_token?${new URLSearchParams({ grant_type: "th_refresh_token", access_token: token })}`,
      LABEL,
      { tenantId }
    );
    return { accessToken: next.access_token, refreshToken: null, expiresAt: new Date(Date.now() + (next.expires_in ?? 60 * 86_400) * 1000) };
  },

  async checkCredentials(creds) {
    try {
      await this.connect(creds);
      return { ok: true };
    } catch (error) {
      if (error instanceof ChannelError && (error.kind === "auth" || error.kind === "permission")) return { ok: false, error: "auth" };
      return { ok: false, error: error instanceof Error ? error.message : "check failed" };
    }
  },

  async publish(creds, post) {
    const { user, token, tenantId } = ctx(creds);
    const text = post.text ?? "";
    if (text.length > THREADS_TEXT_LIMIT) throw new ChannelError("invalid", `Threads matni ${THREADS_TEXT_LIMIT} belgidan oshmasligi kerak (${text.length})`);
    const urls = post.mediaUrls ?? [];
    const replyControl: Record<string, string> = typeof post.options?.replyControl === "string" ? { reply_control: post.options.replyControl } : {};

    if (urls.length === 0) {
      if (!text.trim()) throw new ChannelError("invalid", "Bo'sh post");
      const id = await container(user, token, tenantId, { media_type: "TEXT", text, ...replyControl });
      return publishContainer(user, token, tenantId, id);
    }
    if (urls.length === 1) {
      const video = isVideo(post, urls[0], 0);
      const id = await container(user, token, tenantId, { media_type: video ? "VIDEO" : "IMAGE", [video ? "video_url" : "image_url"]: urls[0], text, ...replyControl });
      return { status: "processing", pollToken: `container:${id}`, retryAfterSec: video ? 30 : 10 };
    }
    if (urls.length > THREADS_CAROUSEL_MAX) throw new ChannelError("invalid", `Threads karuselida ko'pi bilan ${THREADS_CAROUSEL_MAX} ta media`);
    const children: string[] = [];
    for (const [i, url] of urls.entries()) {
      const video = isVideo(post, url, i);
      children.push(await container(user, token, tenantId, { media_type: video ? "VIDEO" : "IMAGE", [video ? "video_url" : "image_url"]: url, is_carousel_item: "true" }));
    }
    const id = await container(user, token, tenantId, { media_type: "CAROUSEL", children: children.join(","), text, ...replyControl });
    return { status: "processing", pollToken: `container:${id}`, retryAfterSec: 30 };
  },

  async continuePublish(creds, pollToken) {
    const { user, token, tenantId } = ctx(creds);
    const id = pollToken.replace(/^container:/, "");
    const state = await metaJson<{ status?: string; error_message?: string }>(threadsGraph(id, { fields: "status,error_message", access_token: token }), LABEL, { tenantId });
    if (state.status === "ERROR" || state.status === "EXPIRED") throw new ChannelError("invalid", `Threads mediani qabul qilmadi${state.error_message ? `: ${state.error_message}` : ""}`);
    if (state.status === "PUBLISHED") throw new ChannelError("invalid", "Bu konteyner allaqachon chiqarilgan");
    if (state.status !== "FINISHED") return { status: "processing", pollToken, retryAfterSec: 30 };
    return publishContainer(user, token, tenantId, id);
  },

  async replyComment(creds, commentId, text) {
    const { user, token, tenantId } = ctx(creds);
    if (text.length > THREADS_TEXT_LIMIT) throw new ChannelError("invalid", `Javob ${THREADS_TEXT_LIMIT} belgidan oshmasin`);
    const id = await container(user, token, tenantId, { media_type: "TEXT", text, reply_to_id: commentId });
    const published = await publishContainer(user, token, tenantId, id);
    return { externalId: published.status === "published" ? published.externalId : id };
  },

  async hideComment(creds, commentId, hide) {
    const { token, tenantId } = ctx(creds);
    await metaJson(threadsGraph(`${commentId}/manage_reply`), LABEL, { form: { hide: String(hide), access_token: token }, tenantId });
  },

  async sendDm() {
    throw new ChannelError("not_supported", "Threads'da shaxsiy xabar API yo'q");
  },

  async privateReply() {
    throw new ChannelError("not_supported", "Threads'da shaxsiy javob API yo'q");
  },

  async fetchInsights(creds, mediaId, metrics) {
    const { token, tenantId } = ctx(creds);
    const list = metrics.length ? metrics : ["views", "likes", "replies", "reposts", "quotes", "shares"];
    const data = await metaJson<{ data?: Array<{ name: string; values?: Array<{ value: number }>; total_value?: { value: number } }> }>(
      threadsGraph(`${mediaId}/insights`, { metric: list.join(","), access_token: token }),
      LABEL,
      { tenantId }
    );
    const out: Record<string, number> = {};
    for (const row of data.data ?? []) {
      const value = row.total_value?.value ?? row.values?.[0]?.value;
      if (typeof value === "number") out[row.name] = value;
    }
    return { externalId: mediaId, metrics: out, fetchedAt: new Date() };
  },
};

// ─── OAuth: Threads login ──────────────────────────────────────────────────────

export function threadsAuthorizeUrl(redirectUri: string, state: string): string {
  const appId = process.env.THREADS_APP_ID?.trim();
  if (!appId) throw new ChannelError("invalid", "THREADS_APP_ID sozlanmagan");
  const url = new URL("https://threads.net/oauth/authorize");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", THREADS_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

/** code → short token → long-lived token (60 days) + the account. */
export async function threadsTokenFromCode(code: string, redirectUri: string): Promise<{ userId: string; username: string | null; accessToken: string; expiresAt: Date }> {
  const appId = process.env.THREADS_APP_ID?.trim() ?? "";
  const secret = process.env.THREADS_APP_SECRET?.trim() ?? "";
  if (!appId || !secret) throw new ChannelError("invalid", "THREADS_APP_ID / THREADS_APP_SECRET sozlanmagan");
  const short = await metaJson<{ access_token: string; user_id: string | number }>(`${HOST}/oauth/access_token`, LABEL, {
    form: { client_id: appId, client_secret: secret, grant_type: "authorization_code", redirect_uri: redirectUri, code },
  });
  const long = await metaJson<{ access_token: string; expires_in?: number }>(
    `${HOST}/access_token?${new URLSearchParams({ grant_type: "th_exchange_token", client_secret: secret, access_token: short.access_token })}`,
    LABEL
  );
  const me = await metaJson<{ id: string; username?: string }>(threadsGraph("me", { fields: "id,username", access_token: long.access_token }), LABEL);
  return { userId: me.id ?? String(short.user_id), username: me.username ?? null, accessToken: long.access_token, expiresAt: new Date(Date.now() + (long.expires_in ?? 60 * 86_400) * 1000) };
}

// ─── Webhook ───────────────────────────────────────────────────────────────────

interface ThreadsReplyValue {
  id?: string;
  username?: string;
  text?: string;
  timestamp?: string;
  media_type?: string;
  replied_to?: { id?: string };
  root_post?: { id?: string; owner_id?: string; username?: string };
}

/**
 * Threads "replies" / "mentions" webhooks. Meta sends either
 * `{ values: { field, value } }` (one or a list) or the Graph-style
 * `{ entry: [{ changes: [...] }] }`; both are accepted.
 */
export function normalizeThreadsWebhook(payload: unknown, rawRef: string | null = null): InboundEvent[] {
  if (!payload || typeof payload !== "object") return [];
  const body = payload as { values?: unknown; target_id?: string; entry?: Array<{ id?: string; changes?: unknown[] }> };
  const changes: Array<{ field?: string; value?: ThreadsReplyValue; account?: string }> = [];
  const push = (raw: unknown, account?: string) => {
    if (raw && typeof raw === "object") changes.push({ ...(raw as { field?: string; value?: ThreadsReplyValue }), account });
  };
  if (Array.isArray(body.values)) body.values.forEach((v) => push(v, body.target_id));
  else push(body.values, body.target_id);
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) push(change, entry.id);

  const events: InboundEvent[] = [];
  for (const change of changes) {
    const value = change.value;
    if (!value?.id) continue;
    const field = change.field ?? "replies";
    if (field !== "replies" && field !== "mentions") continue;
    const owner = value.root_post?.owner_id ?? change.account ?? "";
    if (!owner) continue;
    // Our own reply under our post comes back as a webhook too.
    if (value.username && value.username === value.root_post?.username) continue;
    events.push({
      tenantId: null,
      channel: "threads",
      accountId: owner,
      kind: field === "mentions" ? "mention" : "comment",
      externalId: value.id,
      threadId: value.root_post?.id ?? null,
      author: { externalId: value.username ?? "", username: value.username ?? null },
      text: value.text ?? "",
      media: [],
      createdAt: value.timestamp ? new Date(value.timestamp) : new Date(),
      rawRef,
      parentId: value.replied_to?.id ?? null,
    });
  }
  return events;
}
