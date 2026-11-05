/**
 * Files on Facebook / Threads auto-reply rules: validation per channel, the
 * Messenger attachment after the DM text (link fallback), the link inside a
 * single-message private reply, and the image on a Threads public reply.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "k".repeat(64));

const deleted = vi.hoisted(() => [] as string[]);

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({
  getRedisConnection: () => ({ set: async () => "OK", get: async () => null, del: async () => 1, incr: async () => 1, incrby: async () => 1, decrby: async () => 0, expire: async () => 1 }),
}));
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: vi.fn(async () => 0) }));
vi.mock("../lib/javobai/budget", () => ({ enforceBudgetBeforeCall: async () => ({ allowed: false, flagged: false }) }));
vi.mock("../lib/javobai/knowledge", () => ({ loadKnowledgeBlock: async () => null }));
vi.mock("../lib/assistant/llm/provider", () => ({ getLlmProviderFor: () => null }));
vi.mock("../lib/content/storage", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/content/storage")>();
  return {
    ...real,
    getStorage: () => ({
      presignGet: async (key: string, ttl: number) => `https://cdn.test/${key}?ttl=${ttl}`,
      deleteObject: async (key: string) => {
        deleted.push(key);
      },
    }),
  };
});

import { createAutoReply, deleteAutoReply, ruleProblem, sweepAutoReplies, updateAutoReply, type AutoReplyInput } from "../lib/channels/auto-reply";
import { facebookAdapter } from "../lib/channels/facebook";
import { registerAdapter } from "../lib/channels/registry";
import { REPLY_IMAGE_WAIT, threadsAdapter } from "../lib/channels/threads";
import { putCredential } from "../lib/channels/vault";
import { db, resetDb } from "./helpers/db-instance";

type Route = { match: RegExp; reply: (url: string, body: string) => { status?: number; body?: unknown } };
const calls: Array<{ url: string; body: string }> = [];
let routes: Route[] = [];
const serve = (...next: Route[]) => {
  routes = next;
};
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body == null ? "" : typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "[stream]";
    calls.push({ url, body });
    const route = routes.find((r) => r.match.test(url));
    if (!route) return new Response(JSON.stringify({ error: { message: `no fixture for ${url}`, code: 100 } }), { status: 400 });
    const out = route.reply(url, body);
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
  })
);

const NOW = new Date("2026-10-29T12:00:00Z");
const PDF = { key: "ws/w1/2026/11/abc123.pdf", name: "narxlar.pdf", mime: "application/pdf", size: 1000 };
const PNG = { key: "ws/w1/2026/11/img123.png", name: "menu.png", mime: "image/png", size: 2000 };

function rule(over: Partial<AutoReplyInput> = {}): AutoReplyInput {
  return { channel: "facebook", name: "Narx", enabled: true, appliesTo: "comment", keywords: ["narx"], wholeWord: true, doPublic: true, doPrivate: false, publicReplies: ["DM'ga yozdik!"], privateReplies: [], useAi: false, priority: 0, ...over };
}

let credId = "";
async function setup(channel: "facebook" | "threads" = "facebook") {
  db.seed("workspace", { id: "w1", ownerId: "u1" });
  const cred = await putCredential({ workspaceId: "w1", channel, externalAccountId: channel === "facebook" ? "page1" : "th1", label: "Do'kon", secret: { accessToken: "TOKEN" }, expiresAt: new Date(NOW.getTime() + 3600_000) });
  credId = cred.id;
}

let seq = 0;
function inbound(over: Record<string, unknown> = {}) {
  seq++;
  return db.seed("channelMessage", { id: `m${seq}`, workspaceId: "w1", channel: "facebook", accountRef: credId, kind: "comment", chatId: credId, threadRef: "post1", externalId: `c${seq}`, direction: "IN", authorRef: "u9", authorName: "Ali", text: "narx?", createdAt: new Date(NOW.getTime() - 5 * 60_000), ...over });
}

const bodies = () => calls.map((c) => decodeURIComponent(c.body.replace(/\+/g, " ")));

beforeEach(() => {
  resetDb();
  calls.length = 0;
  deleted.length = 0;
  routes = [];
  seq = 0;
  REPLY_IMAGE_WAIT.delayMs = 0;
  registerAdapter(facebookAdapter);
  registerAdapter(threadsAdapter);
});

describe("file rule validation", () => {
  it("allows a file only where the channel can deliver it", () => {
    expect(ruleProblem(rule({ doPrivate: true, privateReplies: ["x"], file: PDF }))).toBeNull();
    expect(ruleProblem(rule({ file: PDF }))).toMatch(/Messenger/);
    expect(ruleProblem(rule({ channel: "threads", file: PNG }))).toBeNull();
    expect(ruleProblem(rule({ channel: "threads", file: PDF }))).toMatch(/JPG yoki PNG/);
    expect(ruleProblem(rule({ channel: "youtube", file: PNG }))).toMatch(/YouTube/);
    expect(ruleProblem(rule({ doPrivate: true, privateReplies: ["x"], file: { ...PDF, mime: "application/zip" } }))).toMatch(/turdagi/);
  });

  it("refuses a file key from another workspace and cleans up replaced / deleted files", async () => {
    await setup();
    await expect(createAutoReply("w1", rule({ doPrivate: true, privateReplies: ["x"], file: { ...PDF, key: "ws/w2/2026/11/abc123.pdf" } }))).rejects.toThrow(/Fayl topilmadi/);
    // A content upload variant is not a DM file, and the declared type must match the key's.
    await expect(createAutoReply("w1", rule({ doPrivate: true, privateReplies: ["x"], file: { ...PDF, key: "ws/w1/2026/11/abc123.thumb.jpg" } }))).rejects.toThrow(/Fayl topilmadi/);
    await expect(createAutoReply("w1", rule({ channel: "threads", file: { ...PNG, key: "ws/w1/2026/11/abc123.pdf" } }))).rejects.toThrow(/mos emas/);
    const created = await createAutoReply("w1", rule({ doPrivate: true, privateReplies: ["x"], file: PDF }));
    expect(created).toMatchObject({ fileKey: PDF.key, fileName: "narxlar.pdf", fileMime: "application/pdf" });
    await updateAutoReply("w1", created.id, rule({ doPrivate: true, privateReplies: ["x"], file: null }));
    expect(db.rows("channelAutoReply")[0]).toMatchObject({ fileKey: null, fileName: null });
    expect(deleted).toEqual([PDF.key]);
    await updateAutoReply("w1", created.id, rule({ doPrivate: true, privateReplies: ["x"], file: PNG }));
    await deleteAutoReply("w1", created.id);
    expect(deleted).toEqual([PDF.key, PNG.key]);
  });

  it("keeps a file another rule or a campaign still uses", async () => {
    await setup();
    const a = await createAutoReply("w1", rule({ doPrivate: true, privateReplies: ["x"], file: PDF }));
    await createAutoReply("w1", rule({ name: "Nusxa", doPrivate: true, privateReplies: ["x"], file: PDF }));
    db.seed("automation", { id: "camp1", workspaceId: "w1", name: "C", dmMessage: "hi", dmFileKey: PNG.key });
    await updateAutoReply("w1", a.id, rule({ doPrivate: true, privateReplies: ["x"], file: PNG }));
    await deleteAutoReply("w1", a.id);
    expect(deleted).toEqual([]);
  });
});

describe("sending files", () => {
  it("Facebook DM: text, then the file as a Messenger attachment", async () => {
    await setup();
    await createAutoReply("w1", rule({ appliesTo: "dm", doPublic: false, doPrivate: true, privateReplies: ["Narxlar ilovada"], file: PDF }));
    inbound({ kind: "dm", threadRef: "u9", externalId: "mid1" });
    serve({ match: /\/page1\/messages/, reply: () => ({ body: { message_id: `d${calls.length}` } }) });
    expect(await sweepAutoReplies(NOW)).toMatchObject({ sent: 1 });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].body)).toMatchObject({ message: { text: "Narxlar ilovada" } });
    expect(JSON.parse(calls[1].body)).toMatchObject({ recipient: { id: "u9" }, message: { attachment: { type: "file", payload: { url: `https://cdn.test/${PDF.key}?ttl=3600` } } } });
    expect(db.rows("channelAutoReplyLog")[0]).toMatchObject({ status: "SENT", actions: ["dm", "file"] });
  });

  it("Facebook DM: a refused attachment becomes a link message", async () => {
    await setup();
    await createAutoReply("w1", rule({ appliesTo: "dm", doPublic: false, doPrivate: true, privateReplies: ["Narxlar"], file: PDF }));
    inbound({ kind: "dm", threadRef: "u9", externalId: "mid1" });
    serve({ match: /\/page1\/messages/, reply: (_u, body) => (body.includes("attachment") ? { status: 400, body: { error: { code: 100, message: "bad url" } } } : { body: { message_id: "ok" } }) });
    expect(await sweepAutoReplies(NOW)).toMatchObject({ sent: 1 });
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[2].body).message.text).toBe(`📎 narxlar.pdf: https://cdn.test/${PDF.key}?ttl=604800`);
  });

  it("Facebook comment: the private reply carries the file as a link (one message only)", async () => {
    await setup();
    await createAutoReply("w1", rule({ doPrivate: true, privateReplies: ["Narxlar:"], file: PDF }));
    inbound();
    serve({ match: /\/c1\/comments/, reply: () => ({ body: { id: "r1" } }) }, { match: /\/page1\/messages/, reply: () => ({ body: { message_id: "p1" } }) });
    expect(await sweepAutoReplies(NOW)).toMatchObject({ sent: 1 });
    expect(calls).toHaveLength(2);
    const priv = JSON.parse(calls[1].body);
    expect(priv.recipient).toEqual({ comment_id: "c1" });
    expect(priv.message.text).toBe(`Narxlar:\n\n📎 narxlar.pdf: https://cdn.test/${PDF.key}?ttl=604800`);
    expect(db.rows("channelAutoReplyLog")[0]).toMatchObject({ actions: ["public", "private", "file"] });
  });

  it("Threads: the image goes on the public reply once Meta has processed it", async () => {
    await setup("threads");
    await createAutoReply("w1", rule({ channel: "threads", file: PNG }));
    inbound({ channel: "threads" });
    let polls = 0;
    serve(
      { match: /\/th1\/threads_publish/, reply: () => ({ body: { id: "pub1" } }) },
      { match: /\/th1\/threads/, reply: () => ({ body: { id: "cont1" } }) },
      { match: /\/cont1\?/, reply: () => ({ body: { status: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" } }) },
      { match: /\/pub1\?/, reply: () => ({ body: { permalink: "https://threads.net/p/1" } }) }
    );
    expect(await sweepAutoReplies(NOW)).toMatchObject({ sent: 1 });
    const created = bodies()[0];
    expect(created).toContain("media_type=IMAGE");
    expect(created).toContain(`image_url=https://cdn.test/${PNG.key}?ttl=3600`);
    expect(created).toContain("reply_to_id=c1");
    expect(polls).toBe(2);
    expect(db.rows("channelAutoReplyLog")[0]).toMatchObject({ status: "SENT", actions: ["public", "file"] });
  });

  it("Threads: an image Meta rejects still lets the text reply go out, and the log says why", async () => {
    await setup("threads");
    await createAutoReply("w1", rule({ channel: "threads", file: PNG }));
    inbound({ channel: "threads" });
    serve(
      { match: /\/th1\/threads_publish/, reply: (_u, body) => ({ body: { id: body.includes("cont2") ? "pub2" : "never" } }) },
      { match: /\/th1\/threads/, reply: (_u, body) => ({ body: { id: body.includes("IMAGE") ? "cont1" : "cont2" } }) },
      { match: /\/cont1\?/, reply: () => ({ body: { status: "ERROR", error_message: "bad image" } }) },
      { match: /\/pub2\?/, reply: () => ({ body: { permalink: "https://threads.net/p/2" } }) }
    );
    expect(await sweepAutoReplies(NOW)).toMatchObject({ sent: 1 });
    const publishes = bodies().filter((_, i) => calls[i].url.includes("threads_publish"));
    expect(publishes).toHaveLength(1);
    expect(publishes[0]).toContain("creation_id=cont2");
    expect(bodies().find((b) => b.includes("media_type=TEXT"))).toContain("reply_to_id=c1");
    const log = db.rows("channelAutoReplyLog")[0];
    expect(log).toMatchObject({ status: "SENT", actions: ["public"] });
    expect(String(log.error)).toMatch(/bad image/);
  });

  it("Threads: a rate limit on the image reply is not hidden by a text retry", async () => {
    await setup("threads");
    await createAutoReply("w1", rule({ channel: "threads", file: PNG }));
    inbound({ channel: "threads" });
    serve({ match: /\/th1\/threads/, reply: () => ({ status: 400, body: { error: { code: 4, message: "Application request limit reached" } } }) });
    await sweepAutoReplies(NOW);
    expect(calls.filter((c) => c.url.includes("/th1/threads"))).toHaveLength(1);
    expect(db.rows("channelAutoReplyLog")).toHaveLength(0); // deferred to the next sweep
  });

  it("stops picking up new messages once the sweep's time budget is spent", async () => {
    await setup();
    await createAutoReply("w1", rule());
    inbound();
    inbound();
    serve({ match: /\/comments/, reply: () => ({ body: { id: "r" } }) });
    expect(await sweepAutoReplies(NOW, -1)).toMatchObject({ looked: 0 });
    expect(calls).toHaveLength(0);
  });

  it("Facebook comment: a long private reply is shortened so the file link stays whole", async () => {
    await setup();
    await createAutoReply("w1", rule({ doPrivate: true, privateReplies: ["x".repeat(1000)], file: PDF }));
    inbound();
    serve({ match: /\/c1\/comments/, reply: () => ({ body: { id: "r1" } }) }, { match: /\/page1\/messages/, reply: () => ({ body: { message_id: "p1" } }) });
    db.seed("channelMessage", { id: "pad", workspaceId: "w1", channel: "facebook", accountRef: credId, kind: "comment", chatId: credId, threadRef: "post1", externalId: "other", direction: "OUT", text: "", createdAt: NOW });
    expect(await sweepAutoReplies(NOW)).toMatchObject({ sent: 1 });
    const text: string = JSON.parse(calls[1].body).message.text;
    expect(text.endsWith(`📎 narxlar.pdf: https://cdn.test/${PDF.key}?ttl=604800`)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(2000);
  });
});
