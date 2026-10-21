/**
 * Scenario B (TZ 64) end to end against the in-memory database: a price
 * question the model labels OTHER still scores price_asked, qualification asks
 * one thing per message and never re-asks a known field, budget and phone
 * arrive, a lead is created with a +998 phone and separate name / email, and
 * the final score / band follow lib/javobai/scoring.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("INSTAGRAM_APP_ID", "own-app-id");

const redisStore = vi.hoisted(() => new Map<string, string>());
const queues = vi.hoisted(() => ({
  enqueueInbound: vi.fn(async () => {}),
  enqueueEcho: vi.fn(async () => {}),
  scheduleReply: vi.fn(async () => {}),
  enqueueDelivery: vi.fn(async () => {}),
  enqueueNotify: vi.fn(async () => {}),
  enqueueJavobAiInbound: vi.fn(async () => {}),
  enqueueJavobAiEcho: vi.fn(async () => {}),
  scheduleJavobAiReply: vi.fn(async () => {}),
  notifyWorkspaceChats: vi.fn(async () => 1),
  sendEmail: vi.fn(async () => {}),
}));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({
  getRedisConnection: () => ({
    set: async (key: string, value: string, _ex?: string, _ttl?: number, nx?: string) => {
      if (nx === "NX" && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return "OK";
    },
    del: async (key: string) => void redisStore.delete(key),
    incr: async (key: string) => {
      const next = Number(redisStore.get(key) ?? 0) + 1;
      redisStore.set(key, String(next));
      return next;
    },
    expire: async () => 1,
    eval: async (script: string, _numKeys: number, key: string, arg: string | number) => {
      if (script.includes("INCR")) {
        const next = Number(redisStore.get(key) ?? 0) + 1;
        redisStore.set(key, String(next));
        return next;
      }
      if (redisStore.get(key) !== String(arg)) return 0;
      redisStore.delete(key);
      return 1;
    },
  }),
}));
vi.mock("../lib/queue/assistant-queue", () => ({
  enqueueInbound: queues.enqueueInbound,
  enqueueEcho: queues.enqueueEcho,
  scheduleReply: queues.scheduleReply,
  enqueueDelivery: queues.enqueueDelivery,
  enqueueNotify: queues.enqueueNotify,
}));
vi.mock("../lib/javobai/queue", () => ({
  enqueueJavobAiInbound: queues.enqueueJavobAiInbound,
  enqueueJavobAiEcho: queues.enqueueJavobAiEcho,
  scheduleJavobAiReply: queues.scheduleJavobAiReply,
}));
vi.mock("../lib/integrations/throttle", () => ({ acquireSlot: vi.fn(async () => {}) }));
vi.mock("../lib/meta/oauth", () => ({ decryptToken: (value: string) => value, encryptToken: (value: string) => value }));
vi.mock("../lib/meta/token-health", () => ({ markTokenBroken: vi.fn(async () => {}) }));
vi.mock("../lib/telegram/notify", () => ({
  alertWorkspace: vi.fn(async () => {}),
  sendWithRetry: vi.fn(async () => ({ message_id: 1 })),
  notifyWorkspaceChats: queues.notifyWorkspaceChats,
}));
vi.mock("../lib/email", () => ({ sendEmail: queues.sendEmail }));
vi.mock("../lib/meta/client", async (original) => ({
  ...(await original<typeof import("../lib/meta/client")>()),
  sendDirectMessage: vi.fn(async () => ({ recipient_id: "u1", message_id: `mid-${Math.random().toString(36).slice(2)}` })),
  sendSenderAction: vi.fn(async () => {}),
  getMessagingProfile: vi.fn(async () => ({ name: "Aziz Karimov", username: "aziz_ig" })),
}));
vi.mock("../lib/assistant/humanize", async (original) => ({
  ...(await original<typeof import("../lib/assistant/humanize")>()),
  typingDelayMs: () => 0,
}));

import { setLlmProviderForTests, type LLMProvider } from "../lib/assistant/llm/provider";
import { forgetJavobAiGate } from "../lib/javobai/gate";
import { handleJavobAiInbound, runJavobAiReply } from "../lib/javobai/runtime";
import { DEFAULT_SCORING_CONFIG, bandFor } from "../lib/javobai/scoring";
import { sendDirectMessage } from "../lib/meta/client";
import { db, resetDb } from "./helpers/db-instance";

type Row = Record<string, unknown>;
type Out = Partial<{ reply: string; intent: string; confidence: number; used_facts: string[]; extracted: Record<string, string | null> }>;

/** Mocked model: scripted outputs, one per call. */
function llm(outputs: Out[]): LLMProvider {
  let i = 0;
  return {
    name: "fake",
    model: "gemini-3.1-flash-lite",
    costUsd: () => 0.001,
    async complete() {
      const step = outputs[Math.min(i++, outputs.length - 1)];
      return {
        json: {
          reply: step.reply ?? "Tushundim.",
          intent: step.intent ?? "other",
          confidence: step.confidence ?? 0.9,
          used_facts: step.used_facts ?? [],
          extracted: { name: null, email: null, product: null, interest: null, budget: null, location: null, extra_field: null, ...step.extracted },
          language: "uz_latn",
          handoff_request: { needed: false, reason: null },
          unknown_question: null,
          memory_note: null,
        },
        inputTokens: 1000,
        outputTokens: 100,
        model: "gemini-3.1-flash-lite",
        latencyMs: 20,
      };
    },
  };
}

function seedWorld() {
  db.seed("workspace", { id: "w1", ownerId: "owner" });
  db.seed("user", { id: "owner", email: "owner@mebel.uz" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "mebel", instagramId: "ig1", accessToken: "tok" });
  db.seed("assistantProfile", {
    id: "p1", workspaceId: "w1", enabled: true, approvedAt: new Date(), companyName: "Mebel Plus",
    description: "Divan va kreslolar", pricePolicy: "EXACT", delivery: "Toshkent bo'ylab bepul", handleInboundDm: true,
  });
  db.seed("assistantProduct", { profileId: "p1", name: "Milan", price: 4_500_000 });
  const tg = db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
  db.seed("telegramChat", { integrationId: tg.id, chatId: "-100" });
  db.seed("javobAiAccount", { workspaceId: "w1", instagramAccountId: "a1", mode: "LIVE", config: {} });
}

const conv = () => db.rows("conversation")[0];
const state = () => db.rows("aiConversationState")[0];
const sent = () => vi.mocked(sendDirectMessage).mock.calls.map((c) => c[3] as string);
const signals = () => db.rows("aiScoreEvent").map((e) => String(e.signal));
const questionMarks = (s: string) => (s.match(/\?/g) ?? []).length;

async function say(text: string) {
  await handleJavobAiInbound({ instagramAccountId: "ig1", senderId: "u1", messageId: `m-${Math.random()}`, text, hasAttachment: false, shadow: false, source: "webhook" });
  conv().lastCustomerMessageAt = new Date(Date.now() - 10_000);
  await runJavobAiReply(String(conv().id));
}

beforeEach(() => {
  resetDb();
  redisStore.clear();
  vi.clearAllMocks();
  vi.stubEnv("JAVOBAI_DISABLED", "");
  forgetJavobAiGate();
  seedWorld();
});

describe("Scenario B: price question -> qualification -> budget -> phone -> Hot lead", () => {
  it("scores price_asked although the model said OTHER, asks exactly one question per message and never re-asks a known field", async () => {
    setLlmProviderForTests(
      llm([
        // The model misses the price question AND tries to ask both fields in one message.
        { reply: "Salom! Milan divani 4 500 000 so'm. Qaysi mahsulot qiziqtiryapti? Byudjetingiz qancha?", intent: "other", used_facts: ["P1"] },
        { reply: "Yaxshi, Milan divani.", intent: "product_question", used_facts: ["P1"], extracted: { product: "Milan" } },
        // Model asks for the budget although it was just given: must not survive.
        { reply: "Rahmat! Byudjetingiz qancha?", extracted: { budget: "5 mln" } },
      ])
    );

    await say("Salom, narxi qancha?");
    expect(signals()).toEqual(["price_asked"]);
    expect(state()).toMatchObject({ score: 15, temperature: "COLD" });
    expect(questionMarks(sent()[0])).toBe(1);

    await say("Milan divan kerak");
    expect(questionMarks(sent()[1])).toBe(1);
    expect(sent()[1]).toMatch(/byudjet/i);
    expect(state().score).toBe(25);

    await say("5 mln atrofida");
    expect(signals()).toContain("budget_given");
    expect(state().score).toBe(35);
    // Budget known: the next (single) question is the phone, never the budget again.
    expect(sent()[2]).not.toMatch(/byudjet/i);
    expect(sent()[2]).toMatch(/raqam/i);
    for (const message of sent()) expect(questionMarks(message)).toBeLessThanOrEqual(1);
  });

  it("phone + name + email in one message -> lead with +998 phone, name and email separate; score and band follow scoring.ts", async () => {
    setLlmProviderForTests(
      llm([
        { reply: "Salom! Milan 4 500 000 so'm.", intent: "other", used_facts: ["P1"] },
        { reply: "Yaxshi, Milan divani.", intent: "product_question", used_facts: ["P1"], extracted: { product: "Milan" } },
        { reply: "Rahmat!", extracted: { budget: "5 mln" } },
        { reply: "Rahmat!", intent: "gives_contact", extracted: { name: "Ali" } },
      ])
    );
    await say("Salom, narxi qancha?");
    await say("Milan divan kerak");
    await say("5 mln atrofida");
    await say("Ali, ali.k@mail.uz, 90 123 45 67");

    expect(db.rows("lead")).toHaveLength(1);
    const lead = db.rows("lead")[0] as Row;
    expect(lead.phoneE164).toBe("+998901234567");
    expect(lead.name).toBe("Ali");
    expect(String(lead.name)).not.toMatch(/@|\d/);
    expect(db.rows("aiLeadInsight")[0].email).toBe("ali.k@mail.uz");
    expect(lead.productInterest).toBe("Milan");

    // price 15 + product 10 + budget 10 + phone 20 + email 5 = 60 -> Hot (threshold 60).
    // The brief's "70" needs another signal (e.g. purchase_intent 25 without a product; see the next test).
    expect(signals().sort()).toEqual(["budget_given", "email_provided", "phone_provided", "price_asked", "product_selected"]);
    expect(state().score).toBe(15 + 10 + 10 + 20 + 5);
    expect(bandFor(60, DEFAULT_SCORING_CONFIG.thresholds)).toBe("Hot");
    expect(state()).toMatchObject({ temperature: "HOT", handoffState: "HANDOFF_PENDING" });
    expect(db.rows("aiLeadInsight")[0]).toMatchObject({ leadId: lead.id, score: 60, temperature: "HOT", budget: "5 mln" });
  });

  it("price 15 + budget 10 + purchase 25 + phone 20 reaches exactly 70 / Hot", async () => {
    setLlmProviderForTests(
      llm([
        { reply: "Salom! Milan 4 500 000 so'm.", intent: "other", used_facts: ["P1"] },
        { reply: "Tushundim.", intent: "other" },
        { reply: "Yaxshi.", extracted: { budget: "5 mln" } },
        { reply: "Ajoyib!", intent: "purchase_intent" },
        { reply: "Rahmat!", intent: "gives_contact", extracted: { name: "Ali" } },
      ])
    );
    await say("Salom, narxi qancha?");
    await say("Divan kerak");
    await say("5 mln atrofida");
    await say("Olaman");
    expect(sent().at(-1)).toMatch(/raqam/i);
    await say("Ali, 901234567");
    expect(signals().sort()).toEqual(["budget_given", "phone_provided", "price_asked", "purchase_intent"]);
    expect(state().score).toBe(70);
    expect(state().temperature).toBe("HOT");
    expect((db.rows("lead")[0] as Row).phoneE164).toBe("+998901234567");
  });

  it("a signal counts once per cycle: asking the price again adds nothing", async () => {
    setLlmProviderForTests(llm([{ reply: "Salom! Milan 4 500 000 so'm.", intent: "other", used_facts: ["P1"] }]));
    await say("Narxi qancha?");
    await say("Narxlari qancha ekan?");
    expect(signals().filter((s) => s === "price_asked")).toHaveLength(1);
    expect(state().score).toBe(15);
  });
});
