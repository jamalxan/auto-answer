/**
 * Audit phase 6 (T4–T6): Facebook Page, Threads and YouTube adapters against
 * fixture HTTP responses (no live keys), the error mapping, webhook
 * normalisation, private-reply / DM policy, the inbox and cross-posting
 * through the adapters (processing poll, daily limits, quota waits).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "k".repeat(64));
vi.stubEnv("GOOGLE_CLIENT_ID", "gid");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "gsecret");

const redisStore = vi.hoisted(() => new Map<string, string>());
const notify = vi.hoisted(() => vi.fn(async (...args: [string, string, unknown?]) => args.length && 1));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => {
  const add = (key: string, by: number) => {
    const next = Number(redisStore.get(key) ?? 0) + by;
    redisStore.set(key, String(next));
    return next;
  };
  return {
    getRedisConnection: () => ({
      set: async (key: string, value: string, ...rest: unknown[]) => {
        if (rest.includes("NX") && redisStore.has(key)) return null;
        redisStore.set(key, value);
        return "OK";
      },
      get: async (key: string) => redisStore.get(key) ?? null,
      del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
      incr: async (key: string) => add(key, 1),
      incrby: async (key: string, by: number) => add(key, by),
      decrby: async (key: string, by: number) => add(key, -by),
      expire: async () => 1,
    }),
  };
});
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: notify }));
vi.mock("../lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://media.example/${key}` }),
}));

import { googleError, metaError, secondsToPacificMidnight } from "../lib/channels/api";
import { usableCredentials } from "../lib/channels/access";
import { setChannelTargets, sweepCrossPosts } from "../lib/channels/crosspost";
import { facebookAdapter, normalizeFacebookWebhook } from "../lib/channels/facebook";
import { ingestChannelEvents, pollYoutubeInbox, replyToInboxMessage } from "../lib/channels/inbox";
import { sendDmInWindow, sendPrivateReply } from "../lib/channels/policy";
import { adapterFor, registerAdapter } from "../lib/channels/registry";
import { normalizeThreadsWebhook, threadsAdapter } from "../lib/channels/threads";
import { ChannelError, type ChannelAdapter, type ChannelCredentials, type PostVariant } from "../lib/channels/types";
import { putCredential } from "../lib/channels/vault";
import { YOUTUBE_COST, pacificDay, youtubeAdapter, youtubeMetadata } from "../lib/channels/youtube";
import { verifyHubSignature } from "../lib/webhooks/channel-webhook";
import { db, resetDb } from "./helpers/db-instance";

// ─── Fixture HTTP ──────────────────────────────────────────────────────────────

type Route = { method?: string; match: RegExp; reply: (url: string, init: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> } };
const calls: Array<{ method: string; url: string; body: string }> = [];
let routes: Route[] = [];

function serve(...next: Route[]) {
  routes = next;
}

const fakeFetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body === undefined || init.body === null ? "" : typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "[stream]";
  calls.push({ method, url, body });
  const route = routes.find((r) => (!r.method || r.method === method) && r.match.test(url));
  if (!route) return new Response(JSON.stringify({ error: { message: `no fixture for ${method} ${url}`, code: 100 } }), { status: 400 });
  const out = route.reply(url, init);
  const payload = out.body === undefined ? "" : typeof out.body === "string" ? out.body : JSON.stringify(out.body);
  return new Response(payload, { status: out.status ?? 200, headers: out.headers });
});
vi.stubGlobal("fetch", fakeFetch);

const form = (body: string) => Object.fromEntries(new URLSearchParams(body));
const fb: ChannelCredentials = { accessToken: "PAGE_TOKEN", externalAccountId: "page1", extra: { tenantId: "w1" } };
const th: ChannelCredentials = { accessToken: "TH_TOKEN", externalAccountId: "th1" };
const yt: ChannelCredentials = { accessToken: "YT_TOKEN", refreshToken: "YT_REFRESH", externalAccountId: "UCchan", expiresAt: new Date(Date.now() + 3600_000) };
const variant = (over: Partial<PostVariant>): PostVariant => ({ format: "text", text: "Salom", mediaUrls: [], idempotencyKey: "k1", ...over });

beforeEach(() => {
  resetDb();
  redisStore.clear();
  calls.length = 0;
  routes = [];
  vi.clearAllMocks();
  registerAdapter(facebookAdapter);
  registerAdapter(threadsAdapter);
  registerAdapter(youtubeAdapter);
});

// ─── Error mapping ─────────────────────────────────────────────────────────────

describe("error mapping", () => {
  it("maps Meta error codes onto ChannelError kinds", () => {
    expect(metaError(400, { error: { code: 190 } }, "Facebook").kind).toBe("auth");
    expect(metaError(400, { error: { code: 10 } }, "Facebook").kind).toBe("permission");
    expect(metaError(400, { error: { code: 200 } }, "Facebook").kind).toBe("permission");
    const rate = metaError(400, { error: { code: 32 } }, "Facebook");
    expect([rate.kind, rate.retryAfterSec]).toEqual(["rate_limit", 3600]);
    expect(metaError(400, { error: { code: 80002 } }, "Threads").kind).toBe("rate_limit");
    expect(metaError(400, { error: { code: 10, error_subcode: 2018278 } }, "Facebook").kind).toBe("window_closed");
    expect(metaError(500, {}, "Facebook").kind).toBe("transient");
    expect(metaError(400, { error: { code: 100, message: "bad" } }, "Facebook").kind).toBe("invalid");
  });

  it("maps Google errors; quota waits until Pacific midnight", () => {
    const now = new Date("2026-10-27T15:00:00Z"); // 08:00 PDT
    const quota = googleError(403, { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, now);
    expect(quota.kind).toBe("rate_limit");
    expect(quota.retryAfterSec).toBe(16 * 3600);
    expect(secondsToPacificMidnight(now)).toBe(16 * 3600);
    expect(googleError(400, { error: "invalid_grant" }).kind).toBe("auth");
    expect(googleError(401, { error: { code: 401 } }).kind).toBe("auth");
    expect(googleError(403, { error: { code: 403, errors: [{ reason: "forbidden" }] } }).kind).toBe("permission");
  });

  it("never puts the token-bearing URL into an error message", async () => {
    serve({ match: /graph\.facebook\.com/, reply: () => ({ status: 400, body: { error: { code: 100, message: "Invalid parameter" } } }) });
    const error = await facebookAdapter.publish(fb, variant({})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as Error).message).not.toContain("PAGE_TOKEN");
  });
});

// ─── Facebook ──────────────────────────────────────────────────────────────────

describe("Facebook Page adapter", () => {
  it("publishes text to /feed and a single photo to /photos", async () => {
    serve(
      { method: "POST", match: /\/page1\/feed$/, reply: () => ({ body: { id: "page1_100" } }) },
      { method: "POST", match: /\/page1\/photos$/, reply: () => ({ body: { id: "ph1", post_id: "page1_200" } }) }
    );
    expect(await facebookAdapter.publish(fb, variant({}))).toMatchObject({ status: "published", externalId: "page1_100" });
    expect(form(calls[0].body)).toMatchObject({ message: "Salom", access_token: "PAGE_TOKEN" });
    const photo = await facebookAdapter.publish(fb, variant({ format: "image", mediaUrls: ["https://m/a.jpg"] }));
    expect(photo).toMatchObject({ status: "published", externalId: "page1_200" });
  });

  it("publishes several photos as unpublished photos attached to one feed post", async () => {
    let n = 0;
    serve(
      { method: "POST", match: /\/page1\/photos$/, reply: () => ({ body: { id: `ph${++n}` } }) },
      { method: "POST", match: /\/page1\/feed$/, reply: () => ({ body: { id: "page1_300" } }) }
    );
    const result = await facebookAdapter.publish(fb, variant({ format: "carousel", mediaUrls: ["https://m/a.jpg", "https://m/b.jpg"] }));
    expect(result).toMatchObject({ status: "published", externalId: "page1_300" });
    expect(form(calls[0].body).published).toBe("false");
    const feed = form(calls[2].body);
    expect(JSON.parse(feed["attached_media[0]"])).toEqual({ media_fbid: "ph1" });
    expect(JSON.parse(feed["attached_media[1]"])).toEqual({ media_fbid: "ph2" });
  });

  it("uploads a Reel in three steps, then polls until publishing is complete", async () => {
    serve(
      { method: "POST", match: /\/page1\/video_reels$/, reply: (_u, init) => ({ body: form(String(init.body)).upload_phase === "start" ? { video_id: "v9" } : { success: true } }) },
      { method: "POST", match: /rupload\.facebook\.com\/video-upload\/.+\/v9$/, reply: () => ({ body: { success: true } }) }
    );
    const started = await facebookAdapter.publish(fb, variant({ format: "reel", mediaUrls: ["https://m/r.mp4"] }));
    expect(started).toEqual({ status: "processing", pollToken: "reel:v9", retryAfterSec: 30 });
    const upload = calls.find((c) => c.url.includes("rupload"));
    expect(upload).toBeTruthy();
    expect(form(calls[2].body)).toMatchObject({ upload_phase: "finish", video_id: "v9", video_state: "PUBLISHED" });

    serve({ match: /\/v9\?/, reply: () => ({ body: { status: { video_status: "processing", publishing_phase: { status: "in_progress" } } } }) });
    expect((await facebookAdapter.continuePublish(fb, "reel:v9")).status).toBe("processing");
    serve({ match: /\/v9\?/, reply: () => ({ body: { status: { video_status: "ready", publishing_phase: { status: "complete" } } } }) });
    expect(await facebookAdapter.continuePublish(fb, "reel:v9")).toMatchObject({ status: "published", externalId: "v9" });
    serve({ match: /\/v9\?/, reply: () => ({ body: { status: { video_status: "error" } } }) });
    await expect(facebookAdapter.continuePublish(fb, "reel:v9")).rejects.toMatchObject({ kind: "invalid" });
  });

  it("sends a private reply addressed to the comment and a DM as RESPONSE", async () => {
    serve({ method: "POST", match: /\/page1\/messages\?/, reply: () => ({ body: { message_id: "m.1" } }) });
    await facebookAdapter.privateReply(fb, "c77", "Narxi DM'da");
    expect(JSON.parse(calls[0].body)).toEqual({ recipient: { comment_id: "c77" }, message: { text: "Narxi DM'da" } });
    await facebookAdapter.sendDm(fb, "psid1", "Salom");
    expect(JSON.parse(calls[1].body)).toMatchObject({ recipient: { id: "psid1" }, messaging_type: "RESPONSE" });
  });

  it("normalises Page webhooks: comments and Messenger, without the Page's own comments or echoes", () => {
    const events = normalizeFacebookWebhook({
      object: "page",
      entry: [
        {
          id: "page1",
          changes: [
            { field: "feed", value: { item: "comment", verb: "add", comment_id: "c1", post_id: "page1_1", parent_id: "page1_1", message: "Narxi?", created_time: 1_790_000_000, from: { id: "u1", name: "Ali" } } },
            { field: "feed", value: { item: "comment", verb: "add", comment_id: "c2", post_id: "page1_1", parent_id: "c1", message: "Javob", from: { id: "u2" } } },
            { field: "feed", value: { item: "comment", verb: "add", comment_id: "c3", post_id: "page1_1", from: { id: "page1" } } },
            { field: "feed", value: { item: "comment", verb: "edited", comment_id: "c1", post_id: "page1_1", from: { id: "u1" } } },
            { field: "feed", value: { item: "reaction", verb: "add", post_id: "page1_1" } },
          ],
          messaging: [
            { sender: { id: "psid1" }, recipient: { id: "page1" }, timestamp: 1_790_000_000_000, message: { mid: "mid1", text: "Salom" } },
            { sender: { id: "page1" }, recipient: { id: "psid1" }, message: { mid: "mid2", text: "echo", is_echo: true } },
          ],
        },
      ],
    });
    expect(events.map((e) => [e.kind, e.externalId])).toEqual([
      ["comment", "c1"],
      ["reply", "c2"],
      ["dm", "mid1"],
    ]);
    expect(events[0]).toMatchObject({ channel: "facebook", accountId: "page1", threadId: "page1_1", author: { externalId: "u1", name: "Ali" }, text: "Narxi?" });
    expect(events[0].createdAt.getTime()).toBe(1_790_000_000_000);
    expect(normalizeFacebookWebhook({ object: "instagram", entry: [] })).toEqual([]);
  });
});

// ─── Threads ───────────────────────────────────────────────────────────────────

describe("Threads adapter", () => {
  it("publishes text at once (container → threads_publish)", async () => {
    serve(
      { method: "POST", match: /\/th1\/threads$/, reply: () => ({ body: { id: "cont1" } }) },
      { method: "POST", match: /\/th1\/threads_publish$/, reply: () => ({ body: { id: "post1" } }) },
      { match: /\/post1\?/, reply: () => ({ body: { permalink: "https://www.threads.net/@shop/post/x" } }) }
    );
    const result = await threadsAdapter.publish(th, variant({ options: { replyControl: "accounts_you_follow" } }));
    expect(result).toEqual({ status: "published", externalId: "post1", permalink: "https://www.threads.net/@shop/post/x" });
    expect(form(calls[0].body)).toMatchObject({ media_type: "TEXT", text: "Salom", reply_control: "accounts_you_follow" });
  });

  it("rejects text over 500 characters before any call", async () => {
    await expect(threadsAdapter.publish(th, variant({ text: "a".repeat(501) }))).rejects.toMatchObject({ kind: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("waits for an image container to be FINISHED before publishing", async () => {
    serve({ method: "POST", match: /\/th1\/threads$/, reply: () => ({ body: { id: "cont2" } }) });
    const started = await threadsAdapter.publish(th, variant({ format: "image", mediaUrls: ["https://m/a.jpg"] }));
    expect(started).toMatchObject({ status: "processing", pollToken: "container:cont2" });
    expect(form(calls[0].body)).toMatchObject({ media_type: "IMAGE", image_url: "https://m/a.jpg" });

    serve({ match: /\/cont2\?/, reply: () => ({ body: { status: "IN_PROGRESS" } }) });
    expect((await threadsAdapter.continuePublish(th, "container:cont2")).status).toBe("processing");
    serve(
      { match: /\/cont2\?/, reply: () => ({ body: { status: "FINISHED" } }) },
      { method: "POST", match: /threads_publish$/, reply: () => ({ body: { id: "post2" } }) },
      { match: /\/post2\?/, reply: () => ({ body: {} }) }
    );
    expect(await threadsAdapter.continuePublish(th, "container:cont2")).toMatchObject({ status: "published", externalId: "post2" });
    serve({ match: /\/cont2\?/, reply: () => ({ body: { status: "ERROR", error_message: "bad media" } }) });
    await expect(threadsAdapter.continuePublish(th, "container:cont2")).rejects.toThrow(/bad media/);
  });

  it("builds a carousel from item containers", async () => {
    let n = 0;
    serve({ method: "POST", match: /\/th1\/threads$/, reply: () => ({ body: { id: `c${++n}` } }) });
    await threadsAdapter.publish(th, variant({ format: "carousel", mediaUrls: ["https://m/a.jpg", "https://m/b.mp4"] }));
    expect(form(calls[0].body)).toMatchObject({ media_type: "IMAGE", is_carousel_item: "true" });
    expect(form(calls[1].body)).toMatchObject({ media_type: "VIDEO", video_url: "https://m/b.mp4" });
    expect(form(calls[2].body)).toMatchObject({ media_type: "CAROUSEL", children: "c1,c2" });
  });

  it("has no DMs and normalises reply webhooks, skipping our own replies", async () => {
    await expect(threadsAdapter.sendDm(th, "x", "y")).rejects.toMatchObject({ kind: "not_supported" });
    const events = normalizeThreadsWebhook({
      values: [
        { field: "replies", value: { id: "r1", username: "ali", text: "Qancha?", timestamp: "2026-10-27T10:00:00+0000", replied_to: { id: "post1" }, root_post: { id: "post1", owner_id: "th1", username: "shop" } } },
        { field: "replies", value: { id: "r2", username: "shop", text: "DM", root_post: { id: "post1", owner_id: "th1", username: "shop" } } },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ channel: "threads", accountId: "th1", kind: "comment", externalId: "r1", threadId: "post1", parentId: "post1", text: "Qancha?" });
  });
});

// ─── YouTube ───────────────────────────────────────────────────────────────────

describe("YouTube adapter", () => {
  it("titles a Short from the caption's first line with #Shorts", () => {
    expect(youtubeMetadata(variant({ format: "short", text: "Yangi kolleksiya\nBatafsil <b>matn</b>" }))).toEqual({ title: "Yangi kolleksiya #Shorts", description: "Yangi kolleksiya\nBatafsil bmatn/b" });
    expect(youtubeMetadata(variant({ format: "video", text: "x".repeat(150) })).title).toHaveLength(100);
    expect(youtubeMetadata(variant({ format: "short", text: "Zo'r #shorts" })).title).toBe("Zo'r #shorts");
  });

  it("uploads with a resumable session and then waits for processing", async () => {
    serve(
      { match: /media\.example\/v\.mp4/, reply: () => ({ body: "VIDEOBYTES", headers: { "content-type": "video/mp4", "content-length": "10" } }) },
      { method: "POST", match: /upload\/youtube\/v3\/videos\?uploadType=resumable/, reply: () => ({ body: {}, headers: { location: "https://upload.example/session/1" } }) },
      { method: "PUT", match: /upload\.example\/session\/1/, reply: () => ({ body: { id: "vid1", status: { uploadStatus: "uploaded" } } }) }
    );
    const started = await youtubeAdapter.publish(yt, variant({ format: "short", text: "Kuz", mediaUrls: ["https://media.example/v.mp4"], options: { privacyStatus: "unlisted" } }));
    expect(started).toEqual({ status: "processing", pollToken: "video:vid1", retryAfterSec: 60 });
    const meta = JSON.parse(calls[1].body);
    expect(meta).toMatchObject({ snippet: { title: "Kuz #Shorts" }, status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false } });
    expect(Number(redisStore.get(`yt:quota:${pacificDay()}`))).toBe(YOUTUBE_COST.upload);

    serve({ match: /youtube\/v3\/videos\?part=status/, reply: () => ({ body: { items: [{ status: { uploadStatus: "uploaded" } }] } }) });
    expect((await youtubeAdapter.continuePublish(yt, "video:vid1")).status).toBe("processing");
    serve({ match: /youtube\/v3\/videos\?part=status/, reply: () => ({ body: { items: [{ status: { uploadStatus: "processed" } }] } }) });
    expect(await youtubeAdapter.continuePublish(yt, "video:vid1")).toEqual({ status: "published", externalId: "vid1", permalink: "https://www.youtube.com/watch?v=vid1" });
    serve({ match: /youtube\/v3\/videos\?part=status/, reply: () => ({ body: { items: [{ status: { uploadStatus: "rejected", rejectionReason: "duplicate" } }] } }) });
    await expect(youtubeAdapter.continuePublish(yt, "video:vid1")).rejects.toThrow(/duplicate/);
  });

  it("refuses an upload when the project's daily quota is spent, before touching Google", async () => {
    redisStore.set(`yt:quota:${pacificDay()}`, String(10_000 - 100));
    serve({ match: /media\.example/, reply: () => ({ body: "x", headers: { "content-type": "video/mp4" } }) });
    const error = await youtubeAdapter.publish(yt, variant({ format: "video", mediaUrls: ["https://media.example/v.mp4"] })).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "rate_limit" });
    expect((error as ChannelError).retryAfterSec).toBeGreaterThan(0);
    expect(calls.some((c) => c.url.includes("googleapis"))).toBe(false);
    expect(Number(redisStore.get(`yt:quota:${pacificDay()}`))).toBe(10_000 - 100);
  });

  it("only publishes video", async () => {
    await expect(youtubeAdapter.publish(yt, variant({ format: "image", mediaUrls: ["https://m/a.jpg"] }))).rejects.toMatchObject({ kind: "not_supported" });
  });

  it("refreshes an expiring access token before a call and stores it in the vault", async () => {
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    const cred = await putCredential({ workspaceId: "w1", channel: "youtube", externalAccountId: "UCchan", label: "Kanal", secret: { accessToken: "OLD", refreshToken: "R1" }, expiresAt: new Date(Date.now() + 60_000) });
    serve({ method: "POST", match: /oauth2\.googleapis\.com\/token/, reply: () => ({ body: { access_token: "NEW", expires_in: 3600 } }) });
    const ready = await usableCredentials("w1", cred.id);
    expect(ready.accessToken).toBe("NEW");
    expect(form(calls[0].body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "R1" });
    expect((await usableCredentials("w1", cred.id)).accessToken).toBe("NEW");
    expect(calls).toHaveLength(1);

    serve({ method: "POST", match: /oauth2/, reply: () => ({ status: 400, body: { error: "invalid_grant" } }) });
    db.rows("channelCredential")[0].expiresAt = new Date();
    await expect(usableCredentials("w1", cred.id)).rejects.toMatchObject({ kind: "auth" });
    expect(db.rows("channelCredential")[0].status).toBe("ERROR");
  });

  it("polls comments: the first run sets the cursor, later runs bring only new ones into the inbox", async () => {
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    const now = new Date("2026-10-27T11:00:00Z");
    await putCredential({ workspaceId: "w1", channel: "youtube", externalAccountId: "UCchan", secret: { accessToken: "T", refreshToken: "R" }, expiresAt: new Date(now.getTime() + 3600_000) });
    const thread = (id: string, at: string, author = "UCfan") => ({ id, snippet: { videoId: "vid1", topLevelComment: { id, snippet: { authorDisplayName: "Fan", authorChannelId: { value: author }, textOriginal: `t-${id}`, publishedAt: at } } } });
    serve({ match: /commentThreads/, reply: () => ({ body: { items: [thread("c2", "2026-10-27T10:00:00Z"), thread("c1", "2026-10-27T09:00:00Z")] } }) });
    await pollYoutubeInbox(now);
    expect(db.rows("channelMessage")).toHaveLength(0);
    expect(db.rows("channelCredential")[0].pollCursor).toEqual(new Date("2026-10-27T10:00:00Z"));

    // Inside 15 min: not polled again.
    expect((await pollYoutubeInbox(now)).polled).toBe(0);
    redisStore.clear();
    serve({ match: /commentThreads/, reply: () => ({ body: { items: [thread("c4", "2026-10-27T10:50:00Z"), thread("own", "2026-10-27T10:40:00Z", "UCchan"), thread("c3", "2026-10-27T10:30:00Z"), thread("c2", "2026-10-27T10:00:00Z")] } }) });
    await pollYoutubeInbox(now);
    expect(db.rows("channelMessage").map((m) => m.externalId)).toEqual(["c3", "c4"]);
    expect(db.rows("channelMessage")[0]).toMatchObject({ channel: "youtube", kind: "comment", threadRef: "vid1", authorName: "Fan" });
  });
});

// ─── Policy ────────────────────────────────────────────────────────────────────

describe("private reply and DM policy", () => {
  async function fbCredential() {
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    return putCredential({ workspaceId: "w1", channel: "facebook", externalAccountId: "page1", label: "Do'kon", secret: { accessToken: "PAGE_TOKEN" } });
  }

  it("sends one private reply per comment; a second one is refused without a call", async () => {
    const cred = await fbCredential();
    serve({ method: "POST", match: /\/page1\/messages/, reply: () => ({ body: { message_id: "m1" } }) });
    const commentAt = new Date(Date.now() - 86_400_000);
    await sendPrivateReply({ workspaceId: "w1", credentialId: cred.id, commentId: "c1", commentAt, text: "Salom" });
    await expect(sendPrivateReply({ workspaceId: "w1", credentialId: cred.id, commentId: "c1", commentAt, text: "Yana" })).rejects.toThrow(/allaqachon/);
    expect(calls.filter((c) => c.url.includes("/messages"))).toHaveLength(1);
    expect(db.rows("channelPrivateReply")[0]).toMatchObject({ status: "SENT", externalId: "m1" });
  });

  it("refuses after 7 days, and frees the comment only when Meta said no", async () => {
    const cred = await fbCredential();
    await expect(sendPrivateReply({ workspaceId: "w1", credentialId: cred.id, commentId: "old", commentAt: new Date(Date.now() - 8 * 86_400_000), text: "x" })).rejects.toMatchObject({ kind: "window_closed" });

    serve({ method: "POST", match: /\/messages/, reply: () => ({ status: 400, body: { error: { code: 10, message: "no permission" } } }) });
    const at = new Date();
    await expect(sendPrivateReply({ workspaceId: "w1", credentialId: cred.id, commentId: "c2", commentAt: at, text: "x" })).rejects.toMatchObject({ kind: "permission" });
    serve({ method: "POST", match: /\/messages/, reply: () => ({ body: { message_id: "m2" } }) });
    await expect(sendPrivateReply({ workspaceId: "w1", credentialId: cred.id, commentId: "c2", commentAt: at, text: "x" })).resolves.toEqual({ externalId: "m2" });

    // Outcome unknown (network): stays used.
    serve({ method: "POST", match: /\/messages/, reply: () => ({ status: 400, body: "not json" }) });
    fakeFetch.mockRejectedValueOnce(new Error("socket hang up")).mockRejectedValueOnce(new Error("x")).mockRejectedValueOnce(new Error("x")).mockRejectedValueOnce(new Error("x"));
    await expect(sendPrivateReply({ workspaceId: "w1", credentialId: cred.id, commentId: "c3", commentAt: at, text: "x" })).rejects.toMatchObject({ kind: "transient" });
    await expect(sendPrivateReply({ workspaceId: "w1", credentialId: cred.id, commentId: "c3", commentAt: at, text: "x" })).rejects.toThrow(/allaqachon/);
  });

  it("sends a DM only inside the 24-hour window", async () => {
    const cred = await fbCredential();
    serve({ method: "POST", match: /\/messages/, reply: () => ({ body: { message_id: "m3" } }) });
    await expect(sendDmInWindow({ workspaceId: "w1", credentialId: cred.id, recipientId: "p1", text: "x", lastInboundAt: new Date(Date.now() - 25 * 3600_000) })).rejects.toMatchObject({ kind: "window_closed" });
    await expect(sendDmInWindow({ workspaceId: "w1", credentialId: cred.id, recipientId: "p1", text: "x", lastInboundAt: null })).rejects.toMatchObject({ kind: "window_closed" });
    await expect(sendDmInWindow({ workspaceId: "w1", credentialId: cred.id, recipientId: "p1", text: "x", lastInboundAt: new Date(Date.now() - 3600_000) })).resolves.toEqual({ externalId: "m3" });
  });

  it("never uses another workspace's credential", async () => {
    const cred = await fbCredential();
    db.seed("workspace", { id: "w2", ownerId: "u2" });
    await expect(sendDmInWindow({ workspaceId: "w2", credentialId: cred.id, recipientId: "p1", text: "x", lastInboundAt: new Date() })).rejects.toMatchObject({ kind: "auth" });
    expect(calls).toHaveLength(0);
  });
});

// ─── Inbox ─────────────────────────────────────────────────────────────────────

describe("inbox", () => {
  it("stores a webhook event once per connected workspace and answers it from the panel", async () => {
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    db.seed("workspace", { id: "w2", ownerId: "u2" });
    const c1 = await putCredential({ workspaceId: "w1", channel: "facebook", externalAccountId: "page1", secret: { accessToken: "T1" } });
    await putCredential({ workspaceId: "w2", channel: "facebook", externalAccountId: "page1", secret: { accessToken: "T2" } });
    const events = normalizeFacebookWebhook({ object: "page", entry: [{ id: "page1", changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "c1", post_id: "page1_1", message: "Narxi?", from: { id: "u9", name: "Ali" } } }] }] });
    expect(await ingestChannelEvents(events)).toBe(2);
    expect(await ingestChannelEvents(events)).toBe(0);
    expect(notify).toHaveBeenCalledTimes(2);

    const message = db.rows("channelMessage").find((m) => m.workspaceId === "w1")!;
    serve({ method: "POST", match: /\/c1\/comments$/, reply: () => ({ body: { id: "reply1" } }) });
    const out = await replyToInboxMessage("w1", String(message.id), "DM'ga yozdik", "public", "u1");
    expect(out).toMatchObject({ direction: "OUT", externalId: "reply1", accountRef: c1.id, replyToExternalId: "c1" });
    expect(form(calls[0].body)).toMatchObject({ message: "DM'ga yozdik", access_token: "T1" });
    await expect(replyToInboxMessage("w2", String(message.id), "x", "public", "u2")).rejects.toThrow(/topilmadi/);
  });
});

// ─── Cross-posting through adapters ────────────────────────────────────────────

describe("cross-posting to vault channels", () => {
  const NOW = new Date("2026-10-27T12:00:00Z");

  function seedPost(id: string, type = "REEL", withMedia = true) {
    db.seed("scheduledPost", { id, workspaceId: "w1", type, status: "SCHEDULED", caption: "Kuz kolleksiyasi", scheduledAt: new Date(NOW.getTime() - 60_000), deletedAt: null });
    if (withMedia) {
      db.seed("mediaAsset", { id: `m-${id}`, workspaceId: "w1", kind: type === "FEED_IMAGE" ? "IMAGE" : "VIDEO", originalKey: `k/${id}.mp4`, preparedKey: null, sizeBytes: 1000, preparedBytes: null });
      db.seed("scheduledPostMedia", { id: `pm-${id}`, postId: id, mediaId: `m-${id}`, position: 0 });
    }
  }

  function fake(channel: "facebook" | "threads" | "youtube", impl: Partial<ChannelAdapter>): ChannelAdapter {
    const base = adapterFor(channel)!;
    const adapter = { ...base, ...impl, channel, capabilities: base.capabilities } as ChannelAdapter;
    registerAdapter(adapter);
    return adapter;
  }

  it("publishes a Reel to Facebook as a Reel, polls processing, and marks it published", async () => {
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    const cred = await putCredential({ workspaceId: "w1", channel: "facebook", externalAccountId: "page1", label: "Do'kon", secret: { accessToken: "T" } });
    seedPost("p1");
    await setChannelTargets("w1", "p1", "facebook", [cred.id]);
    const publish = vi.fn(async (_c: ChannelCredentials, post: PostVariant) => {
      expect(post.format).toBe("reel");
      expect(post.mediaUrls).toEqual(["https://media.example/k/p1.mp4"]);
      return { status: "processing" as const, pollToken: "reel:v1", retryAfterSec: 30 };
    });
    const poll = vi.fn(async () => ({ status: "published" as const, externalId: "v1" }));
    fake("facebook", { publish, continuePublish: poll });

    await sweepCrossPosts(NOW);
    expect(db.rows("channelPostTarget")[0]).toMatchObject({ status: "PUBLISHING", pollToken: "reel:v1", attempts: 1 });
    await sweepCrossPosts(new Date(NOW.getTime() + 10_000));
    expect(poll).not.toHaveBeenCalled(); // not due yet
    const later = await sweepCrossPosts(new Date(NOW.getTime() + 31_000));
    expect(later.published).toBe(1);
    expect(db.rows("channelPostTarget")[0]).toMatchObject({ status: "PUBLISHED", externalIds: ["v1"], pollToken: null });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("skips formats a channel cannot take (an image post on YouTube)", async () => {
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    const cred = await putCredential({ workspaceId: "w1", channel: "youtube", externalAccountId: "UC1", secret: { accessToken: "T", refreshToken: "R" }, expiresAt: new Date(NOW.getTime() + 3600_000) });
    seedPost("p2", "FEED_IMAGE");
    await setChannelTargets("w1", "p2", "youtube", [cred.id]);
    const publish = vi.fn();
    fake("youtube", { publish });
    const result = await sweepCrossPosts(NOW);
    expect(result.skipped).toBe(1);
    expect(db.rows("channelPostTarget")[0].status).toBe("SKIPPED");
    expect(publish).not.toHaveBeenCalled();
  });

  it("moves a target to the quota reset instead of failing it, without spending an attempt", async () => {
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    const cred = await putCredential({ workspaceId: "w1", channel: "youtube", externalAccountId: "UC1", secret: { accessToken: "T", refreshToken: "R" }, expiresAt: new Date(NOW.getTime() + 3 * 3600_000) });
    seedPost("p3");
    await setChannelTargets("w1", "p3", "youtube", [cred.id]);
    fake("youtube", { publish: vi.fn(async () => Promise.reject(new ChannelError("rate_limit", "kvota", 5 * 3600))) });
    await sweepCrossPosts(NOW);
    const row = db.rows("channelPostTarget")[0];
    expect(row).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((row.nextAttemptAt as Date).getTime()).toBe(NOW.getTime() + 5 * 3600_000);
    expect(notify).not.toHaveBeenCalled();
    // Not retried before the reset, and not failed as "late" afterwards.
    await sweepCrossPosts(new Date(NOW.getTime() + 3600_000));
    expect(db.rows("channelPostTarget")[0].attempts).toBe(0);
  });

  it("holds Threads posts back once 250 went out in 24 h", async () => {
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    const cred = await putCredential({ workspaceId: "w1", channel: "threads", externalAccountId: "th1", secret: { accessToken: "T" } });
    for (let i = 0; i < 250; i++) db.seed("channelPostTarget", { id: `old${i}`, workspaceId: "w1", postId: `x${i}`, channel: "threads", accountRef: cred.id, status: "PUBLISHED", publishedAt: new Date(NOW.getTime() - 3600_000 - i * 1000) });
    seedPost("p4", "FEED_IMAGE");
    await setChannelTargets("w1", "p4", "threads", [cred.id]);
    const publish = vi.fn();
    fake("threads", { publish });
    await sweepCrossPosts(NOW);
    const row = db.rows("channelPostTarget").find((t) => t.postId === "p4")!;
    expect(row.status).toBe("PENDING");
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
    expect(publish).not.toHaveBeenCalled();
  });

  it("fails and alerts on a permanent error; refuses targets of another workspace", async () => {
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    db.seed("workspace", { id: "w2", ownerId: "u2" });
    const cred = await putCredential({ workspaceId: "w1", channel: "facebook", externalAccountId: "page1", label: "Do'kon", secret: { accessToken: "T" } });
    const foreign = await putCredential({ workspaceId: "w2", channel: "facebook", externalAccountId: "page2", secret: { accessToken: "T" } });
    seedPost("p5", "FEED_IMAGE");
    await expect(setChannelTargets("w1", "p5", "facebook", [foreign.id])).rejects.toThrow(/topilmadi/);
    await setChannelTargets("w1", "p5", "facebook", [cred.id]);
    fake("facebook", { publish: vi.fn(async () => Promise.reject(new ChannelError("permission", "Facebook ruxsati yetarli emas"))) });
    await sweepCrossPosts(NOW);
    expect(db.rows("channelPostTarget")[0].status).toBe("FAILED");
    expect(notify.mock.calls[0][1]).toContain("Facebook'ga post chiqmadi");
    expect(notify.mock.calls[0][1]).toContain("Do'kon");
  });
});

// ─── Webhook signature ─────────────────────────────────────────────────────────

describe("webhook signature", () => {
  it("accepts only the app secret's HMAC", async () => {
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({ object: "page" });
    const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    expect(verifyHubSignature(body, good, "s3cret")).toBe(true);
    expect(verifyHubSignature(body, good, "other")).toBe(false);
    expect(verifyHubSignature(`${body} `, good, "s3cret")).toBe(false);
    expect(verifyHubSignature(body, null, "s3cret")).toBe(false);
  });
});
