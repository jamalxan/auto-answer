/**
 * Auto-replies for Facebook / Threads / YouTube: rule validation, matching,
 * the sweeper (public + private reply, DMs, idempotency, safety skips, hourly
 * cap) and the AI reply guards. Facebook / YouTube go through fixture HTTP.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "k".repeat(64));
vi.stubEnv("GOOGLE_CLIENT_ID", "gid");
vi.stubEnv("GOOGLE_CLIENT_SECRET", "gsecret");

const redisStore = vi.hoisted(() => new Map<string, string>());
const ai = vi.hoisted(() => ({
  reply: "Ha, 25 000 so'm turadi." as string,
  provider: true,
  gate: { allowed: true, flagged: false },
  block: { text: "P1: Divan Milan - 25 000 so'm", lines: [{ id: "P1", kind: "product", text: "Divan Milan - 25 000 so'm" }] } as { text: string; lines: unknown[] } | null,
  calls: 0,
}));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({
  getRedisConnection: () => ({
    set: async (key: string, value: string, ...rest: unknown[]) => {
      if (rest.includes("NX") && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return "OK";
    },
    get: async (key: string) => redisStore.get(key) ?? null,
    del: async (key: string) => (redisStore.delete(key) ? 1 : 0),
    incr: async (key: string) => {
      const next = Number(redisStore.get(key) ?? 0) + 1;
      redisStore.set(key, String(next));
      return next;
    },
    incrby: async (key: string, by: number) => {
      const next = Number(redisStore.get(key) ?? 0) + by;
      redisStore.set(key, String(next));
      return next;
    },
    decrby: async () => 0,
    expire: async () => 1,
  }),
}));
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: vi.fn(async () => 0) }));
vi.mock("../lib/javobai/budget", () => ({ enforceBudgetBeforeCall: async () => ai.gate }));
vi.mock("../lib/javobai/knowledge", () => ({ loadKnowledgeBlock: async () => ai.block }));
vi.mock("../lib/assistant/llm/provider", () => ({
  getLlmProviderFor: () =>
    ai.provider
      ? {
          name: "fake",
          model: "fake-model",
          costUsd: () => 0,
          complete: async () => {
            ai.calls++;
            return { json: { reply: ai.reply }, inputTokens: 10, outputTokens: 5, model: "fake-model", latencyMs: 5 };
          },
        }
      : null,
}));

import {
  AUTO_REPLY_CAP_PER_HOUR,
  createAutoReply,
  fillPlaceholders,
  listAutoReplyLog,
  pickRule,
  pickVariant,
  ruleProblem,
  sweepAutoReplies,
  unknownContacts,
  updateAutoReply,
  type AutoReplyInput,
} from "../lib/channels/auto-reply";
import { facebookAdapter } from "../lib/channels/facebook";
import { registerAdapter } from "../lib/channels/registry";
import { putCredential } from "../lib/channels/vault";
import { youtubeAdapter } from "../lib/channels/youtube";
import { db, resetDb } from "./helpers/db-instance";

type Route = { match: RegExp; reply: (url: string, body: string) => { status?: number; body?: unknown } };
const calls: Array<{ method: string; url: string; body: string }> = [];
let routes: Route[] = [];
const serve = (...next: Route[]) => {
  routes = next;
};
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body === undefined || init.body === null ? "" : typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : "[stream]";
    calls.push({ method: (init.method ?? "GET").toUpperCase(), url, body });
    const route = routes.find((r) => r.match.test(url));
    if (!route) return new Response(JSON.stringify({ error: { message: `no fixture for ${url}`, code: 100 } }), { status: 400 });
    const out = route.reply(url, body);
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
  })
);

const NOW = new Date("2026-10-29T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function rule(over: Partial<AutoReplyInput> = {}): AutoReplyInput {
  return { channel: "facebook", name: "Narx", enabled: true, appliesTo: "comment", keywords: ["narx"], wholeWord: true, doPublic: true, doPrivate: false, publicReplies: ["{name}, DM'ga yozdik!"], privateReplies: [], useAi: false, priority: 0, ...over };
}

let credId = "";
async function setup(channel: "facebook" | "youtube" = "facebook") {
  db.seed("workspace", { id: "w1", ownerId: "u1" });
  const cred = await putCredential({ workspaceId: "w1", channel, externalAccountId: channel === "facebook" ? "page1" : "UCchan", label: "Do'kon", secret: { accessToken: "TOKEN", refreshToken: "R" }, expiresAt: new Date(NOW.getTime() + 3600_000) });
  credId = cred.id;
  return cred;
}

let seq = 0;
function inbound(over: Record<string, unknown> = {}) {
  seq++;
  return db.seed("channelMessage", { id: `m${seq}`, workspaceId: "w1", channel: "facebook", accountRef: credId, kind: "comment", chatId: credId, threadRef: "post1", externalId: `c${seq}`, direction: "IN", authorRef: "u9", authorName: "Ali Valiyev", text: "Narx qancha?", createdAt: minutesAgo(5), ...over });
}

beforeEach(() => {
  resetDb();
  redisStore.clear();
  calls.length = 0;
  routes = [];
  seq = 0;
  ai.reply = "Ha, 25 000 so'm turadi.";
  ai.provider = true;
  ai.gate = { allowed: true, flagged: false };
  ai.block = { text: "P1: Divan Milan - 25 000 so'm", lines: [{ id: "P1", kind: "product", text: "Divan Milan - 25 000 so'm" }] };
  ai.calls = 0;
  registerAdapter(facebookAdapter);
  registerAdapter(youtubeAdapter);
});

describe("pure helpers", () => {
  const base = { id: "r1", channel: "facebook", credentialId: null, enabled: true, appliesTo: "comment", keywords: ["narx"], wholeWord: true, priority: 0, createdAt: new Date(0) };
  const msg = { channel: "facebook", accountRef: "a1", kind: "comment", text: "Narx qancha?" };

  it("matches keywords (whole word, case) and treats an empty list as any", () => {
    expect(pickRule([base], { ...msg, text: "NARX?" })?.id).toBe("r1");
    expect(pickRule([base], { ...msg, text: "narxlar" })).toBeNull();
    expect(pickRule([{ ...base, keywords: [] }], { ...msg, text: "salom" })?.id).toBe("r1");
  });

  it("respects channel, account, kind, enabled and priority", () => {
    const high = { ...base, id: "hi", priority: 5, keywords: [] };
    expect(pickRule([base, high], { ...msg, text: "narx" })?.id).toBe("hi");
    expect(pickRule([{ ...base, credentialId: "other" }], { ...msg, text: "narx" })).toBeNull();
    expect(pickRule([{ ...base, enabled: false }], { ...msg, text: "narx" })).toBeNull();
    expect(pickRule([{ ...base, channel: "youtube" }], { ...msg, text: "narx" })).toBeNull();
    expect(pickRule([base], { ...msg, kind: "reply", text: "narx" })).toBeNull();
    expect(pickRule([base], { ...msg, kind: "dm", text: "narx" })).toBeNull();
    expect(pickRule([{ ...base, appliesTo: "both" }], { ...msg, kind: "dm", text: "narx" })?.id).toBe("r1");
  });

  it("picks a stable variant per seed and fills {name} without a dangling gap", () => {
    expect(pickVariant([], "s")).toBeNull();
    expect(pickVariant(["a", "b", "c"], "x")).toBe(pickVariant(["a", "b", "c"], "x"));
    expect(fillPlaceholders("{name}, rahmat!", "Ali Valiyev")).toBe("Ali, rahmat!");
    expect(fillPlaceholders("Salom {name}!", null)).toBe("Salom!");
  });

  it("flags links, handles and phones the knowledge never mentioned", () => {
    expect(unknownContacts("Yozing: +998 90 123 45 67", "Telefon +998901234567")).toEqual([]);
    expect(unknownContacts("Yozing: +998 90 123 45 67", "Faqat narxlar")).toHaveLength(1);
    expect(unknownContacts("Saytga kiring: https://evil.example/x", "Sayt https://shop.uz")).toHaveLength(1);
    expect(unknownContacts("Saytga kiring: https://shop.uz", "Sayt https://shop.uz")).toEqual([]);
  });
});

describe("rule validation", () => {
  it("rejects what the channel cannot do", () => {
    expect(ruleProblem(rule({ channel: "youtube", appliesTo: "dm", doPrivate: true }))).toMatch(/shaxsiy xabar yo'q/);
    expect(ruleProblem(rule({ channel: "youtube", doPrivate: true }))).toMatch(/shaxsiy javob yo'q/);
    expect(ruleProblem(rule({ channel: "threads", doPrivate: true, privateReplies: ["x"] }))).toMatch(/shaxsiy javob yo'q/);
    expect(ruleProblem(rule({ appliesTo: "dm", doPrivate: false }))).toMatch(/shaxsiy javob/);
    expect(ruleProblem(rule({ publicReplies: [], useAi: false }))).toMatch(/javob matni/);
    expect(ruleProblem(rule({ publicReplies: [], useAi: true }))).toBeNull();
    expect(ruleProblem(rule({ doPrivate: true, privateReplies: [] }))).toMatch(/shaxsiy javob/i);
    expect(ruleProblem(rule())).toBeNull();
  });

  it("stores rules per workspace and refuses another workspace's account", async () => {
    await setup();
    db.seed("workspace", { id: "w2", ownerId: "u2" });
    await expect(createAutoReply("w2", rule({ credentialId: credId }))).rejects.toThrow(/Akkaunt topilmadi/);
    const created = await createAutoReply("w1", rule({ credentialId: credId }));
    expect(created.credentialId).toBe(credId);
    await expect(updateAutoReply("w2", created.id, rule())).rejects.toThrow(/Qoida topilmadi/);
    await expect(createAutoReply("w1", { channel: "facebook", name: "" })).rejects.toThrow();
  });
});

describe("sweepAutoReplies", () => {
  it("answers a keyword comment publicly and privately, once", async () => {
    await setup();
    await createAutoReply("w1", rule({ doPrivate: true, privateReplies: ["Narxlar ro'yxati: 25 000"] }));
    const m = inbound();
    serve(
      { match: /\/c1\/comments/, reply: () => ({ body: { id: "reply1" } }) },
      { match: /\/page1\/messages/, reply: () => ({ body: { message_id: "dm1" } }) }
    );
    const first = await sweepAutoReplies(NOW);
    expect(first).toMatchObject({ looked: 1, sent: 1, failed: 0 });
    expect(calls.map((c) => c.url).join(" ")).toMatch(/c1\/comments.*page1\/messages/);
    expect(decodeURIComponent(calls[0].body.replace(/\+/g, " "))).toContain("Ali, DM'ga yozdik!");
    const outs = db.rows("channelMessage").filter((r) => r.direction === "OUT");
    expect(outs.map((o) => o.kind).sort()).toEqual(["comment", "dm"]);
    expect(db.rows("channelAutoReplyLog")[0]).toMatchObject({ messageId: m.id, status: "SENT", actions: ["public", "private"] });
    expect(db.rows("channelAutoReply")[0]).toMatchObject({ sentCount: 1 });

    calls.length = 0;
    expect(await sweepAutoReplies(NOW)).toMatchObject({ looked: 0, sent: 0 });
    expect(calls).toHaveLength(0);
    expect((await listAutoReplyLog("w1"))[0].message?.text).toBe("Narx qancha?");
  });

  it("skips non-matching comments, own comments, replies-to-replies and ones a person answered", async () => {
    await setup();
    await createAutoReply("w1", rule());
    inbound({ text: "Zo'r!" });
    inbound({ authorRef: "page1" });
    inbound({ kind: "reply" });
    const answered = inbound();
    db.seed("channelMessage", { id: "out1", workspaceId: "w1", channel: "facebook", accountRef: credId, kind: "comment", chatId: credId, threadRef: "post1", externalId: "o1", direction: "OUT", replyToExternalId: answered.externalId, text: "Javob", createdAt: minutesAgo(2) });
    expect(await sweepAutoReplies(NOW)).toMatchObject({ sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(db.rows("channelAutoReplyLog").find((l) => l.messageId === answered.id)?.error).toBe("human_replied");
  });

  it("ignores messages older than the window and disabled rules", async () => {
    await setup();
    const r = await createAutoReply("w1", rule());
    inbound({ createdAt: minutesAgo(60 * 7) });
    expect((await sweepAutoReplies(NOW)).looked).toBe(0);
    db.rows("channelAutoReply").find((x) => x.id === r.id)!.enabled = false;
    inbound();
    expect((await sweepAutoReplies(NOW)).looked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("answers a Messenger DM with the private text", async () => {
    await setup();
    await createAutoReply("w1", rule({ appliesTo: "dm", doPublic: false, doPrivate: true, privateReplies: ["Salom! Narxlar: 25 000"] }));
    inbound({ kind: "dm", threadRef: "u9", externalId: "mid1", text: "narx?" });
    serve({ match: /\/page1\/messages/, reply: () => ({ body: { message_id: "dm9" } }) });
    expect(await sweepAutoReplies(NOW)).toMatchObject({ sent: 1 });
    expect(JSON.parse(calls[0].body)).toMatchObject({ recipient: { id: "u9" }, message: { text: "Salom! Narxlar: 25 000" } });
  });

  it("logs a failure and never retries it (no duplicate to the customer)", async () => {
    await setup();
    await createAutoReply("w1", rule());
    inbound();
    serve({ match: /comments/, reply: () => ({ status: 400, body: { error: { code: 100, message: "bad" } } }) });
    expect(await sweepAutoReplies(NOW)).toMatchObject({ failed: 1 });
    expect(db.rows("channelAutoReplyLog")[0]).toMatchObject({ status: "FAILED" });
    calls.length = 0;
    await sweepAutoReplies(NOW);
    expect(calls).toHaveLength(0);
  });

  it("holds back when the account's hourly cap is used up", async () => {
    await setup();
    await createAutoReply("w1", rule());
    for (let i = 0; i < AUTO_REPLY_CAP_PER_HOUR.facebook; i++) {
      db.seed("channelAutoReplyLog", { workspaceId: "w1", channel: "facebook", credentialId: credId, messageId: `old${i}`, status: "SENT", createdAt: minutesAgo(10) });
    }
    inbound();
    expect(await sweepAutoReplies(NOW)).toMatchObject({ looked: 1, sent: 0 });
    expect(calls).toHaveLength(0);
    // Not logged: the next hour picks it up.
    expect(db.rows("channelAutoReplyLog").some((l) => l.messageId === "m1")).toBe(false);
  });

  it("replies to a YouTube comment publicly", async () => {
    await setup("youtube");
    await createAutoReply("w1", rule({ channel: "youtube", name: "YT" }));
    inbound({ channel: "youtube", authorRef: "UCviewer" });
    serve({ match: /youtube\/v3\/comments/, reply: () => ({ body: { id: "ytreply1" } }) });
    expect(await sweepAutoReplies(NOW)).toMatchObject({ sent: 1 });
    expect(db.rows("channelMessage").find((r) => r.direction === "OUT")).toMatchObject({ externalId: "ytreply1", channel: "youtube" });
  });
});

describe("AI replies", () => {
  async function aiRule(over: Partial<AutoReplyInput> = {}) {
    await setup();
    db.seed("assistantProfile", { id: "ap1", workspaceId: "w1", instagramAccountId: null });
    await createAutoReply("w1", rule({ useAi: true, publicReplies: ["Rahmat! DM'ga yozing."], ...over }));
    inbound();
    serve({ match: /\/c1\/comments/, reply: () => ({ body: { id: "r" } }) }, { match: /\/page1\/messages/, reply: () => ({ body: { message_id: "d" } }) });
  }
  const allSent = () => calls.map((c) => decodeURIComponent(c.body.replace(/\+/g, " "))).join(" | ");

  it("keeps the fixed variant for the public reply and uses AI for the private one", async () => {
    await aiRule({ doPrivate: true, privateReplies: ["Fallback matn"] });
    await sweepAutoReplies(NOW);
    expect(ai.calls).toBe(1);
    expect(allSent()).toContain("Rahmat!");
    expect(allSent()).toContain("25 000 so'm turadi");
    expect(db.rows("channelAutoReplyLog")[0]).toMatchObject({ usedAi: true });
  });

  it("falls back to the variant when the AI invents a number", async () => {
    await aiRule({ doPublic: false, doPrivate: true, privateReplies: ["Fallback matn"] });
    ai.reply = "Ha, 99 000 so'm turadi.";
    await sweepAutoReplies(NOW);
    expect(allSent()).toContain("Fallback matn");
    expect(allSent()).not.toContain("99 000");
    expect(db.rows("channelAutoReplyLog")[0]).toMatchObject({ usedAi: false });
  });

  it("never sends a link the knowledge does not contain", async () => {
    await aiRule({ doPublic: false, doPrivate: true, privateReplies: ["Fallback matn"] });
    ai.reply = "Saytga kiring: https://evil.example";
    await sweepAutoReplies(NOW);
    expect(allSent()).not.toContain("evil.example");
    expect(allSent()).toContain("Fallback matn");
  });

  it("uses the variants when there is no knowledge base", async () => {
    ai.block = null;
    await aiRule({ doPublic: false, doPrivate: true, privateReplies: ["Fallback matn"] });
    await sweepAutoReplies(NOW);
    expect(allSent()).toContain("Fallback matn");
  });

  it("does not call the model when the budget is spent; nothing to say = skipped", async () => {
    ai.gate = { allowed: false, flagged: true };
    await aiRule({ publicReplies: [], doPublic: true });
    await sweepAutoReplies(NOW);
    expect(ai.calls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(db.rows("channelAutoReplyLog")[0]).toMatchObject({ status: "SKIPPED", error: "no_text" });
  });
});
