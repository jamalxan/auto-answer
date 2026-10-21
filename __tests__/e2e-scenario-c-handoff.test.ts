/**
 * Scenario C (TZ 64): "menejer kerak" -> handoff -> Telegram operator alert
 * (Telegram API mocked, real notifier) -> silence for further customer
 * messages -> operator presses Qabul / Yopish in Telegram -> AI answers again.
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
vi.mock("../lib/telegram/api", async (original) => ({
  ...(await original<typeof import("../lib/telegram/api")>()),
  isTelegramConfigured: () => true,
  answerCallbackQuery: vi.fn(async () => ({})),
  editMessageText: vi.fn(async () => ({})),
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
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
import { sendDirectMessage } from "../lib/meta/client";
import { sendMessage as tgSendMessage } from "../lib/telegram/api";
import { handleTelegramUpdate, type TgUpdate } from "../lib/telegram/bot";
import type { BotIO } from "../lib/telegram/onboarding";
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
  const tg = db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram", status: "ACTIVE" });
  db.seed("telegramChat", { integrationId: tg.id, chatId: "-100", active: true });
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
const tgMessages = () => vi.mocked(tgSendMessage).mock.calls.map((c) => ({ chatId: String(c[0]), text: String(c[1]), options: c[2] as { keyboard?: Array<Array<{ callback_data?: string }>> } | undefined }));
let updateId = 5000;
const press = (data: string): TgUpdate => ({
  update_id: ++updateId,
  callback_query: {
    id: `cb${updateId}`,
    from: { id: 555, language_code: "uz", username: "manager" },
    message: { message_id: 7, chat: { id: -100, type: "supergroup", title: "Leads" } },
    data,
  },
});
function fakeIo() {
  const out: Array<{ chatId: string; text: string }> = [];
  const io: BotIO = {
    send: async (chatId, text) => {
      out.push({ chatId, text });
      return { message_id: out.length };
    },
    edit: async () => ({}),
    download: async () => Buffer.alloc(0),
  };
  return { io, out };
}

describe("Scenario C: 'menejer kerak' -> handoff -> silence -> operator closes -> AI resumes", () => {
  it("runs the whole cycle", async () => {
    setLlmProviderForTests(
      llm([
        { reply: "Albatta.", intent: "wants_human" },
        { reply: "Ha, Toshkent bo'ylab bepul.", intent: "product_question", used_facts: ["B3"] },
        { reply: "Milan 4 500 000 so'm.", intent: "product_question", used_facts: ["P1"] },
        { reply: "Yaxshi.", intent: "product_question", used_facts: ["P1"] },
        { reply: "Ha, Toshkent bo'ylab bepul.", intent: "product_question", used_facts: ["B3"] },
      ])
    );

    // 1. the request -> exactly one 'accepted' message + a Telegram alert with the two buttons
    await say("Menejer kerak");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatch(/menejer/i);
    expect(state().handoffState).toBe("HANDOFF_PENDING");
    expect(db.rows("aiHandoff")[0]).toMatchObject({ status: "OPEN", reason: "wants_human" });
    expect(db.rows("lead")).toHaveLength(0);

    const alerts = tgMessages();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].chatId).toBe("-100");
    expect(alerts[0].text).toContain("Mijoz operator so'radi");
    expect(alerts[0].options?.keyboard?.[0].map((b) => b.callback_data)).toEqual([`jai:take:${conv().id}`, `jai:close:${conv().id}`]);

    // 2. three more customer messages: zero AI replies, no further 'accepted' line, no second alert
    const before = sent().length;
    await say("Yetkazib berish bormi?");
    await say("Milan narxi qancha?");
    await say("Hello?");
    expect(sent()).toHaveLength(before);
    expect(tgMessages()).toHaveLength(1);
    expect(db.rows("aiHandoff")).toHaveLength(1);
    expect(state().handoffState).toBe("HANDOFF_PENDING");

    // 3. the operator takes the chat and closes it from Telegram
    const { io, out } = fakeIo();
    await handleTelegramUpdate(press(`jai:take:${conv().id}`), io);
    expect(state().handoffState).toBe("OPERATOR_ACTIVE");
    await say("Rahmat, kutyapman");
    expect(sent()).toHaveLength(before); // operator owns the thread
    await handleTelegramUpdate(press(`jai:close:${conv().id}`), io);
    expect(state().handoffState).toBe("CLOSED");
    expect(db.rows("aiHandoff")[0]).toMatchObject({ status: "CLOSED", closedBy: "tg:@manager", resumeAi: true });
    expect(conv().operatorActiveUntil).toBeNull();
    expect(out.some((m) => m.text.includes("yopildi"))).toBe(true);

    // 4. the next customer message is answered by the AI again
    await say("Yetkazib berish bormi?");
    expect(sent().length).toBe(before + 1);
    expect(state().handoffState).toBe("AI_ACTIVE");
  });

  it("a human request in Uzbek Latin, Cyrillic and Russian hands off (model labels wants_human)", async () => {
    for (const text of ["Menejer kerak", "Operator bilan gaplashmoqchiman", "Мне нужен менеджер", "Менежер керак"]) {
      resetDb();
      redisStore.clear();
      vi.clearAllMocks();
      forgetJavobAiGate();
      seedWorld();
      setLlmProviderForTests(llm([{ reply: "Albatta.", intent: "wants_human" }]));
      await say(text);
      expect(state().handoffState, text).toBe("HANDOFF_PENDING");
    }
  });
});
