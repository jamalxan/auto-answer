/**
 * JavobAI engine against the in-memory database: the gate, LIVE end to end
 * (TZ 64 scenarios B and C), SHADOW (read-only), the lock, mode switches,
 * echo / close / resume and the sandbox.
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
    // The two Lua scripts the engine uses: compare-and-delete (lock release) and INCR+PEXPIRE (media slot).
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
import { DEBOUNCE_MS } from "../lib/assistant/humanize";
import { forgetJavobAiGate, getJavobAiMode, routeAssistantEcho, routeAssistantInbound } from "../lib/javobai/gate";
import { acceptHandoff, closeHandoff, openHandoff } from "../lib/javobai/handoff";
import { previewKnowledge } from "../lib/javobai/knowledge";
import { handJavobAiThread, handleJavobAiEcho, handleJavobAiInbound, runJavobAiReply } from "../lib/javobai/runtime";
import { runJavobAiSandbox } from "../lib/javobai/sandbox";
import { sendDirectMessage } from "../lib/meta/client";
import { db, resetDb } from "./helpers/db-instance";

type Row = Record<string, unknown>;
type Out = Partial<{ reply: string; intent: string; confidence: number; used_facts: string[]; extracted: Record<string, string | null>; unknown_question: string | null }>;

function llm(outputs: Out[]): LLMProvider {
  let i = 0;
  return {
    name: "fake",
    model: "gemini-3.1-flash-lite",
    costUsd: (inp, out) => (inp * 0.25 + out * 1.5) / 1_000_000,
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
          unknown_question: step.unknown_question ?? null,
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

function seedWorld(mode: "OFF" | "SHADOW" | "LIVE" | null = "LIVE", config: Row = {}) {
  db.seed("workspace", { id: "w1", ownerId: "owner" });
  db.seed("user", { id: "owner", email: "owner@mebel.uz" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "mebel", instagramId: "ig1", accessToken: "tok" });
  db.seed("assistantProfile", {
    id: "p1", workspaceId: "w1", enabled: true, approvedAt: new Date(), companyName: "Mebel Plus",
    description: "Divan va kreslolar", pricePolicy: "EXACT", delivery: "Toshkent bo'ylab bepul", handleInboundDm: true,
  });
  db.seed("assistantProduct", { profileId: "p1", name: "Milan", price: 4_500_000 });
  db.seed("aiKnowledgeEntry", { profileId: "p1", kind: "DISCOUNT", title: "Oktabr", body: "10% chegirma", verifiedAt: new Date() });
  db.seed("aiKnowledgeEntry", { profileId: "p1", kind: "POLICY", title: "Qoralama", body: "ko'rinmasin", verifiedAt: null });
  const tg = db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
  db.seed("telegramChat", { integrationId: tg.id, chatId: "-100" });
  if (mode) db.seed("javobAiAccount", { workspaceId: "w1", instagramAccountId: "a1", mode, config });
}

const event = (text: string, mid = `m-${Math.random()}`) => ({ instagramAccountId: "ig1", senderId: "u1", messageId: mid, text, hasAttachment: false });
const inbound = (text: string, mid?: string, extra: Partial<Parameters<typeof handleJavobAiInbound>[0]> = {}) =>
  handleJavobAiInbound({ ...event(text, mid), shadow: false, source: "webhook", ...extra });
const conv = () => db.rows("conversation")[0];
const state = () => db.rows("aiConversationState")[0];
const sent = () => vi.mocked(sendDirectMessage).mock.calls.map((c) => c[3] as string);
const settle = () => {
  conv().lastCustomerMessageAt = new Date(Date.now() - 10_000);
};
/** One customer message, debounced and answered. */
async function say(text: string) {
  await inbound(text);
  settle();
  await runJavobAiReply(String(conv().id));
}

beforeEach(() => {
  resetDb();
  redisStore.clear();
  vi.clearAllMocks();
  vi.stubEnv("JAVOBAI_DISABLED", "");
  forgetJavobAiGate();
  setLlmProviderForTests(llm([{ reply: "Tushundim." }]));
});

describe("gate", () => {
  it("OFF (no row): production queue only, exactly as before", async () => {
    seedWorld(null);
    const e = event("salom", "m1");
    await routeAssistantInbound(e);
    expect(queues.enqueueInbound).toHaveBeenCalledWith(e);
    expect(queues.enqueueJavobAiInbound).not.toHaveBeenCalled();
    expect(await getJavobAiMode("a1")).toBe("OFF");
  });

  it("SHADOW: production queue plus a shadow copy; LIVE: JavobAI only", async () => {
    seedWorld("SHADOW");
    await routeAssistantInbound(event("salom", "m1"));
    expect(queues.enqueueInbound).toHaveBeenCalledTimes(1);
    expect(queues.enqueueJavobAiInbound).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m1", shadow: true }));

    db.rows("javobAiAccount")[0].mode = "LIVE";
    forgetJavobAiGate("a1");
    vi.clearAllMocks();
    await routeAssistantInbound(event("salom", "m2"));
    expect(queues.enqueueInbound).not.toHaveBeenCalled();
    expect(queues.enqueueJavobAiInbound).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m2", shadow: false }));
  });

  it("caches the mode for 30s until forgotten", async () => {
    seedWorld("LIVE");
    expect(await getJavobAiMode("a1")).toBe("LIVE");
    db.rows("javobAiAccount")[0].mode = "OFF";
    expect(await getJavobAiMode("a1")).toBe("LIVE");
    forgetJavobAiGate("a1");
    expect(await getJavobAiMode("a1")).toBe("OFF");
  });

  it("kill switch, a dead profile and errors all read OFF → production", async () => {
    seedWorld("LIVE");
    vi.stubEnv("JAVOBAI_DISABLED", "1");
    await routeAssistantInbound(event("salom", "m1"));
    expect(queues.enqueueInbound).toHaveBeenCalledTimes(1);
    expect(queues.enqueueJavobAiInbound).not.toHaveBeenCalled();

    vi.stubEnv("JAVOBAI_DISABLED", "");
    db.rows("assistantProfile")[0].enabled = false;
    forgetJavobAiGate();
    expect(await getJavobAiMode("a1")).toBe("OFF");

    db.rows("assistantProfile")[0].enabled = true;
    forgetJavobAiGate();
    const spy = vi.spyOn(db, "model").mockImplementation(() => {
      throw new Error("db down");
    });
    vi.clearAllMocks();
    await routeAssistantInbound(event("salom", "m2"));
    spy.mockRestore();
    expect(queues.enqueueInbound).toHaveBeenCalledTimes(1);
  });

  it("a LIVE enqueue failure falls back to production", async () => {
    seedWorld("LIVE");
    queues.enqueueJavobAiInbound.mockRejectedValueOnce(new Error("redis down"));
    await routeAssistantInbound(event("salom", "m1"));
    expect(queues.enqueueInbound).toHaveBeenCalledTimes(1);
  });

  it("echoes always reach production; LIVE accounts also get the JavobAI copy", async () => {
    seedWorld("LIVE");
    const echo = { instagramAccountId: "ig1", customerId: "u1", messageId: "e1", text: "Salom", appId: null };
    await routeAssistantEcho(echo);
    expect(queues.enqueueEcho).toHaveBeenCalledWith(echo);
    expect(queues.enqueueJavobAiEcho).toHaveBeenCalledWith(echo);
  });

  it("signed attachment urls never reach production's queue (OFF and SHADOW); the LIVE job keeps them", async () => {
    const attachments = [{ type: "audio", url: "https://lookaside.fbsbx.com/v.ogg?signature=secret-token" }];
    seedWorld(null);
    await routeAssistantInbound({ ...event("", "m1"), hasAttachment: true, attachments });
    expect(queues.enqueueInbound).toHaveBeenCalledWith({ ...event("", "m1"), hasAttachment: true });
    expect(JSON.stringify(queues.enqueueInbound.mock.calls)).not.toContain("secret-token");

    resetDb();
    vi.clearAllMocks();
    forgetJavobAiGate();
    seedWorld("SHADOW");
    await routeAssistantInbound({ ...event("", "m2"), hasAttachment: true, attachments });
    expect(JSON.stringify(queues.enqueueInbound.mock.calls)).not.toContain("secret-token");
    expect(JSON.stringify(queues.enqueueJavobAiInbound.mock.calls)).not.toContain("secret-token"); // SHADOW ignores media
    expect(queues.enqueueJavobAiInbound).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m2", shadow: true, hasAttachment: true }));

    resetDb();
    vi.clearAllMocks();
    forgetJavobAiGate();
    seedWorld("LIVE");
    await routeAssistantInbound({ ...event("", "m3"), hasAttachment: true, attachments });
    expect(queues.enqueueInbound).not.toHaveBeenCalled();
    expect(queues.enqueueJavobAiInbound).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m3", shadow: false, attachments }));
  });

  it("caches 'account not found' for 30s like a mode", async () => {
    seedWorld("LIVE");
    const unknown = { ...event("salom", "m1"), instagramAccountId: "ig-unknown" };
    await routeAssistantInbound(unknown);
    expect(queues.enqueueInbound).toHaveBeenCalledWith(unknown);
    const spy = vi.spyOn(db, "model");
    await routeAssistantInbound({ ...unknown, messageId: "m2" });
    expect(spy.mock.calls.filter((c) => c[0] === "instagramAccount")).toHaveLength(0);
    expect(queues.enqueueInbound).toHaveBeenCalledTimes(2);
    // Connecting the account (the dev UI forgets the gate) makes it visible again.
    forgetJavobAiGate();
    await routeAssistantInbound({ ...unknown, messageId: "m3" });
    expect(spy.mock.calls.filter((c) => c[0] === "instagramAccount")).toHaveLength(1);
    spy.mockRestore();
  });
});

describe("LIVE: scenario B + C end to end", () => {
  it("KB answer → qualification → purchase → phone → 🧪 TEST 🔥 lead → handoff → post-handoff → echo → close → resume", async () => {
    seedWorld("LIVE", { postHandoffReplies: 2 });
    setLlmProviderForTests(
      llm([
        { reply: "Ha, Milan divanimiz bor, 4 500 000 so'm.", intent: "product_question", used_facts: ["P1"], extracted: { product: "Milan" } },
        { reply: "Yaxshi, Milan sizga mos keladi.", extracted: { budget: "5 mln" } },
        { reply: "Ajoyib tanlov!", intent: "purchase_intent" },
        { reply: "Rahmat!", intent: "gives_contact", extracted: { name: "Ali" } },
        { reply: "Ha, Toshkent bo'ylab bepul.", intent: "product_question", used_facts: ["B3"] },
        { reply: "Naqd va click.", intent: "product_question", used_facts: ["B3"] },
      ])
    );

    // 1. inbound: stored once, debounced once, nothing sent yet
    await inbound("Salom, divan bormi?", "m1");
    await inbound("Salom, divan bormi?", "m1");
    expect(db.rows("conversationMessage")).toHaveLength(1);
    expect(queues.scheduleJavobAiReply).toHaveBeenCalledTimes(1);
    expect(queues.scheduleJavobAiReply).toHaveBeenCalledWith(conv().id, DEBOUNCE_MS);
    expect(conv().igUsername).toBe("aziz_ig");
    expect(sendDirectMessage).not.toHaveBeenCalled();

    // 2. the answer from the KB, with the budget question appended
    settle();
    await runJavobAiReply(String(conv().id));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatch(/^Ha, Milan divanimiz bor, 4 500 000 so'm\.\n.*byudjet/i);
    const reply1 = db.rows("conversationMessage").find((m) => m.author === "ASSISTANT") as Row;
    expect(reply1.mid).toMatch(/^mid-/);
    expect(reply1.llmMeta).toMatchObject({ javobai: true, intent: "product_question", usedFacts: ["P1"], askedField: "budget" });
    expect(state()).toMatchObject({ score: 10, temperature: "COLD", turns: 1, extracted: { product: "Milan" } });
    expect(db.rows("aiScoreEvent").map((e) => e.signal)).toEqual(["product_selected"]);
    expect(db.rows("workspace")[0].aiConversationsThisPeriod).toBe(1);
    expect(db.rows("llmUsage")).toHaveLength(1);
    expect(db.rows("llmUsage")[0]).toMatchObject({ kind: "javobai_reply" });
    expect(Number(db.rows("llmUsage")[0].costUsd)).toBeGreaterThan(0);

    // 3. budget answered → qualification done → phone asked
    await say("5 mln atrofida");
    expect(sent()[1]).toMatch(/raqam/i);
    expect(state()).toMatchObject({ score: 20 });
    expect(db.rows("workspace")[0].aiConversationsThisPeriod).toBe(1); // counted once

    // 4. purchase intent → phone asked again (purchase template), no handoff yet
    await say("Olaman");
    expect(sent()[2]).toMatch(/raqam/i);
    expect(state()).toMatchObject({ score: 45, temperature: "WARM", handoffState: "AI_ACTIVE" });
    expect(db.rows("aiHandoff")).toHaveLength(0);

    // 5. the number → lead with the prefixes, insight, handoff with alert + buttons
    await say("Ali, 90 123 45 67");
    expect(sent()[3]).toContain("+998 90 123 45 67");
    expect(state()).toMatchObject({ score: 65, temperature: "HOT", handoffState: "HANDOFF_PENDING" });
    const lead = db.rows("lead")[0] as Row;
    expect(lead.phoneE164).toBe("+998901234567");
    expect(lead.name).toBe("Ali");
    expect(lead.productInterest).toBe("Milan");
    expect(lead.summary).toBe("🧪 TEST · 🔥 HOT 65 · Sotib olmoqchi: Milan. Byudjet: 5 mln.");
    expect(db.rows("aiLeadInsight")[0]).toMatchObject({ leadId: lead.id, score: 65, temperature: "HOT", budget: "5 mln", isTest: true });
    expect(queues.enqueueDelivery).toHaveBeenCalled();
    expect(db.rows("aiHandoff")[0]).toMatchObject({ status: "OPEN", reason: "purchase_ready" });
    expect(conv().assistantState).toBe("HANDED_OFF");
    expect(queues.notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    const [, html, options] = queues.notifyWorkspaceChats.mock.calls[0] as unknown as [string, string, { keyboard: Array<Array<{ callback_data?: string }>> }];
    expect(html).toContain("Sotib olishga tayyor");
    expect(html).toContain("🔥 HOT 65");
    expect(options.keyboard[0].map((b) => b.callback_data)).toEqual([`jai:take:${conv().id}`, `jai:close:${conv().id}`]);
    expect(queues.sendEmail).toHaveBeenCalled();
    expect(db.rows("aiContactMemory")[0]).toMatchObject({ igUserId: "u1", leadIds: [lead.id] });

    // 6. pending: two grounded replies, then silence; a second lead is never made
    await say("Yetkazib berish bormi?");
    expect(sent()[4]).toBe("Ha, Toshkent bo'ylab bepul.");
    await say("To'lov qanday?");
    expect(sent()[5]).toBe("Naqd va click.");
    await say("Yana bir savol");
    expect(sent()).toHaveLength(6);
    expect(db.rows("lead")).toHaveLength(1);
    expect(queues.enqueueNotify).toHaveBeenCalledWith({ kind: "customer_wrote_again", conversationId: conv().id });

    // 7. the operator answers from the app (echo) → OPERATOR_ACTIVE
    await handleJavobAiEcho({ instagramAccountId: "ig1", customerId: "u1", messageId: "op-1", text: "Salom, men menejer", appId: "other-app" });
    expect(state().handoffState).toBe("OPERATOR_ACTIVE");
    expect(db.rows("aiHandoff")[0]).toMatchObject({ status: "ACCEPTED", acceptedBy: "echo" });
    expect(conv().operatorActiveUntil).toBeInstanceOf(Date);
    vi.clearAllMocks();
    await inbound("Rahmat");
    expect(queues.scheduleJavobAiReply).not.toHaveBeenCalled();

    // 8. close → the next customer message brings the AI back, memory kept
    expect(await closeHandoff(String(conv().id), "dev")).toBe("CLOSED");
    expect(conv().operatorActiveUntil).toBeNull();
    await inbound("Yana savolim bor");
    expect(state().handoffState).toBe("AI_ACTIVE");
    expect(state().extracted).toMatchObject({ product: "Milan", budget: "5 mln" });
    expect(queues.scheduleJavobAiReply).toHaveBeenCalledTimes(1);
  });

  it("grounding: an unanswerable question → template + knowledge gap; the second one → handoff", async () => {
    seedWorld("LIVE");
    setLlmProviderForTests(llm([{ reply: "50 000 so'm", intent: "price_question", used_facts: [] }]));
    await say("Samarqandga yetkazish qancha?");
    expect(sent()[0]).toMatch(/menda yo'q|ayta olmayman/);
    expect(db.rows("knowledgeGap")).toHaveLength(1);
    expect(state().unknownStreak).toBe(1);
    expect(db.rows("aiHandoff")).toHaveLength(0);

    await say("Buxoroga-chi?");
    expect(state().handoffState).toBe("HANDOFF_PENDING");
    expect(db.rows("aiHandoff")[0]).toMatchObject({ reason: "unknown_streak" });
    expect(db.rows("lead")).toHaveLength(0);
  });

  it("wants_human hands off with the alert and no lead (scenario C)", async () => {
    seedWorld("LIVE");
    setLlmProviderForTests(llm([{ reply: "Albatta.", intent: "wants_human" }]));
    await say("Menejer bilan gaplashmoqchiman");
    expect(sent()[0]).toMatch(/menejer/i);
    expect(state().handoffState).toBe("HANDOFF_PENDING");
    expect((queues.notifyWorkspaceChats.mock.calls[0] as unknown as [string, string])[1]).toContain("Mijoz operator so'radi");
    expect(db.rows("lead")).toHaveLength(0);
  });

  it("max turns (config) hands off", async () => {
    seedWorld("LIVE", { maxTurns: 4 });
    await inbound("salom");
    state().turns = 4;
    settle();
    await runJavobAiReply(String(conv().id));
    expect(db.rows("aiHandoff")[0]).toMatchObject({ reason: "max_turns" });
  });

  it("the shared conversation lock prevents a double reply", async () => {
    seedWorld("LIVE");
    await inbound("salom");
    settle();
    redisStore.set(`conv:${conv().id}:lock`, "1");
    await runJavobAiReply(String(conv().id));
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(queues.scheduleJavobAiReply).toHaveBeenLastCalledWith(conv().id, 3000);
  });

  it("stays silent under the hard mute and while a trigger flow's operator owns the thread", async () => {
    seedWorld("LIVE");
    db.seed("conversation", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1", operatorActiveUntil: new Date(Date.now() + 3600_000) });
    await inbound("salom");
    expect(queues.scheduleJavobAiReply).not.toHaveBeenCalled();

    db.rows("conversation")[0].operatorActiveUntil = null;
    const ev = db.seed("instagramEvent", { workspaceId: "w1", instagramAccountId: "a1", senderId: "u1", eventType: "COMMENT", messageId: "cmt1", timestamp: new Date() });
    const camp = db.seed("triggerCampaign", { workspaceId: "w1", instagramAccountId: "a1", triggerType: "COMMENT", name: "Narx" });
    // HANDOFF chip: the operator has the thread.
    db.seed("triggerExecution", { workspaceId: "w1", eventId: ev.id, campaignId: camp.id, status: "SENT", sentAt: new Date(), openedAt: new Date(), lastInboundAt: null, stoppedAt: new Date(), stopReason: "Operatorga o'tkazildi", handedOffAt: new Date() });
    await inbound("narxi?");
    expect(queues.scheduleJavobAiReply).not.toHaveBeenCalled();
    expect(db.rows("assistantEvent").find((e) => e.type === "jai_trigger_owns_thread")?.payload).toMatchObject({ reason: "handoff" });
  });

  it("answers after a MESSAGE chip (the trigger engine never answers a plain DM), stays silent while a LEAD_CAPTURE chip waits", async () => {
    seedWorld("LIVE");
    const ev = db.seed("instagramEvent", { workspaceId: "w1", instagramAccountId: "a1", senderId: "u1", eventType: "COMMENT", messageId: "cmt1", timestamp: new Date() });
    const camp = db.seed("triggerCampaign", { workspaceId: "w1", instagramAccountId: "a1", triggerType: "COMMENT", name: "Narx", active: true });
    db.seed("triggerQuickReply", { campaignId: camp.id, label: "Narxlar", action: "MESSAGE", responseText: "Narxlar: ...", sort: 0 });
    // The customer tapped the MESSAGE chip a minute ago: the execution is active for 24h but nobody would answer the next question.
    const exec = db.seed("triggerExecution", { workspaceId: "w1", eventId: ev.id, campaignId: camp.id, status: "SENT", sentAt: new Date(Date.now() - 120_000), openedAt: new Date(Date.now() - 60_000), lastInboundAt: new Date(Date.now() - 60_000), stoppedAt: null, stopReason: null, handedOffAt: null, leadCapturedAt: null });
    await inbound("Milan divani bormi?");
    expect(queues.scheduleJavobAiReply).toHaveBeenCalledTimes(1);
    expect(db.rows("assistantEvent").some((e) => e.type === "jai_trigger_owns_thread")).toBe(false);

    // The same campaign also offers a LEAD_CAPTURE chip the person has not used yet: the number is still expected there.
    vi.clearAllMocks();
    db.seed("triggerQuickReply", { campaignId: camp.id, label: "Raqam", action: "LEAD_CAPTURE", responseText: null, sort: 1 });
    await inbound("Yana bir savol");
    expect(queues.scheduleJavobAiReply).not.toHaveBeenCalled();
    expect(db.rows("assistantEvent").find((e) => e.type === "jai_trigger_owns_thread")?.payload).toMatchObject({ reason: "lead_capture", executionId: exec.id });

    // The lead was captured: JavobAI answers again.
    vi.clearAllMocks();
    exec.leadCapturedAt = new Date();
    await inbound("Rahmat, yana savol");
    expect(queues.scheduleJavobAiReply).toHaveBeenCalledTimes(1);
  });

  it("legacy keyword campaign (dmTriggerEnabled) answers the DM itself: no second reply from JavobAI", async () => {
    seedWorld("LIVE");
    db.seed("automation", { id: "auto1", workspaceId: "w1", instagramAccountId: "a1", isActive: true, dmTriggerEnabled: true, keywords: ["narx"], matchAnyWord: false, wholeWordMatch: true });
    await inbound("Narx qancha?");
    expect(queues.scheduleJavobAiReply).not.toHaveBeenCalled();
    expect(db.rows("assistantEvent").some((e) => e.type === "jai_keyword_campaign_answers")).toBe(true);
    expect(db.rows("conversationMessage")).toHaveLength(1); // stored, so the next message has the history

    // A message the keyword campaign does not match is answered.
    await inbound("Yetkazib berish bormi?");
    expect(queues.scheduleJavobAiReply).toHaveBeenCalledTimes(1);
  });

  it("a reply to a campaign DM keeps the campaign attribution (dmLog → campaignId / CAMPAIGN) on the conversation and the lead", async () => {
    seedWorld("LIVE");
    db.seed("automation", { id: "auto1", workspaceId: "w1", instagramAccountId: "a1", isActive: true, dmTriggerEnabled: false, keywords: ["aksiya"], handoffToAssistant: true });
    db.seed("dmLog", { workspaceId: "w1", automationId: "auto1", instagramAccountId: "a1", commenterId: "u1", status: "SENT", dmSentAt: new Date(Date.now() - 3600_000) });
    setLlmProviderForTests(llm([{ reply: "Rahmat!", intent: "gives_contact" }]));
    await say("Ali, 90 123 45 67");
    expect(conv()).toMatchObject({ campaignId: "auto1", source: "CAMPAIGN" });
    expect(db.rows("lead")[0]).toMatchObject({ campaignId: "auto1", source: "CAMPAIGN" });
  });

  it("honours the profile switches: no reply without handleInboundDm, campaign replies by handleCampaignReplies (a typed number is still a lead)", async () => {
    seedWorld("LIVE");
    db.rows("assistantProfile")[0].handleInboundDm = false;
    await inbound("Salom, divan bormi?");
    expect(queues.scheduleJavobAiReply).not.toHaveBeenCalled();
    expect(db.rows("conversationMessage")).toHaveLength(1);

    // A campaign whose replies are not handed to the assistant: phase-1 behaviour, the number becomes a lead.
    db.seed("automation", { id: "auto1", workspaceId: "w1", instagramAccountId: "a1", isActive: true, dmTriggerEnabled: false, handoffToAssistant: false });
    db.seed("dmLog", { workspaceId: "w1", automationId: "auto1", instagramAccountId: "a1", commenterId: "u1", status: "SENT", dmSentAt: new Date() });
    await inbound("90 123 45 67");
    expect(queues.scheduleJavobAiReply).not.toHaveBeenCalled();
    expect(conv()).toMatchObject({ campaignId: "auto1", assistantState: "HANDED_OFF", collected: { phone_e164: "+998901234567" } });
    expect(db.rows("lead")[0]).toMatchObject({ phoneE164: "+998901234567", campaignId: "auto1", summary: "Mijoz kampaniya DM'iga raqam yozib javob berdi." });

    // handleCampaignReplies on: a campaign reply is answered even with handleInboundDm off.
    resetDb();
    vi.clearAllMocks();
    forgetJavobAiGate();
    seedWorld("LIVE");
    db.rows("assistantProfile")[0].handleInboundDm = false;
    db.seed("automation", { id: "auto2", workspaceId: "w1", instagramAccountId: "a1", isActive: true, dmTriggerEnabled: false, handoffToAssistant: true });
    db.seed("dmLog", { workspaceId: "w1", automationId: "auto2", instagramAccountId: "a1", commenterId: "u1", status: "SENT", dmSentAt: new Date() });
    await inbound("Qiziq, batafsil?");
    expect(queues.scheduleJavobAiReply).toHaveBeenCalledTimes(1);

    // The AI quick-reply action is an explicit handover: the switches do not apply to it.
    resetDb();
    vi.clearAllMocks();
    forgetJavobAiGate();
    seedWorld("LIVE");
    db.rows("assistantProfile")[0].handleInboundDm = false;
    await inbound("AI bilan gaplashish", undefined, { source: "trigger" });
    expect(queues.scheduleJavobAiReply).toHaveBeenCalledTimes(1);
  });

  it("a LIVE job on an account switched OFF is a no-op", async () => {
    seedWorld("OFF");
    await inbound("salom");
    expect(db.rows("conversation")).toHaveLength(0);
    expect(queues.scheduleJavobAiReply).not.toHaveBeenCalled();
  });
});

describe("echo (operator took over)", () => {
  async function pendingHandoff() {
    seedWorld("LIVE");
    setLlmProviderForTests(llm([{ reply: "Albatta.", intent: "wants_human" }]));
    await say("Menejer bilan gaplashmoqchiman");
    expect(state().handoffState).toBe("HANDOFF_PENDING");
  }
  const echo = (messageId: string, appId: string | null = "other-app") => ({ instagramAccountId: "ig1", customerId: "u1", messageId, text: "Salom, men menejer", appId });

  it("production's handleEcho stored the OPERATOR row first: the handoff still becomes OPERATOR_ACTIVE", async () => {
    await pendingHandoff();
    // Both echo jobs are delayed 3s and production's is enqueued first.
    db.seed("conversationMessage", { conversationId: conv().id, mid: "op-1", author: "OPERATOR", text: "Salom, men menejer" });
    await handleJavobAiEcho(echo("op-1"));
    expect(state().handoffState).toBe("OPERATOR_ACTIVE");
    expect(db.rows("aiHandoff")[0]).toMatchObject({ status: "ACCEPTED", acceptedBy: "echo" });
  });

  it("our own sends (ASSISTANT rows) and campaign DMs just logged as sent never accept a handoff", async () => {
    await pendingHandoff();
    const own = db.rows("conversationMessage").find((m) => m.author === "ASSISTANT") as Row;
    await handleJavobAiEcho(echo(String(own.mid)));
    expect(state().handoffState).toBe("HANDOFF_PENDING");

    // A campaign DM echoed with a foreign app_id (production's "justSent" rule).
    db.seed("automation", { id: "auto1", workspaceId: "w1", instagramAccountId: "a1" });
    db.seed("dmLog", { workspaceId: "w1", automationId: "auto1", instagramAccountId: "a1", commenterId: "u1", status: "SENT", dmSentAt: new Date(Date.now() - 30_000) });
    await handleJavobAiEcho(echo("campaign-dm-1"));
    expect(state().handoffState).toBe("HANDOFF_PENDING");

    // Our own app id is never an operator either.
    await handleJavobAiEcho(echo("x", "own-app-id"));
    expect(state().handoffState).toBe("HANDOFF_PENDING");
  });
});

describe("AI quick-reply action (handJavobAiThread)", () => {
  const hand = (executionId = "exec1") =>
    handJavobAiThread({
      account: { id: "a1", workspaceId: "w1", instagramId: "ig1" },
      igUserId: "u1",
      igUsername: "aziz_ig",
      messageId: `tap-${executionId}`,
      text: "AI bilan gaplashish",
      context: { campaignName: "Narx", executionId, quickReplyLabel: "AI bilan gaplashish" },
    });

  it("reopens a pending / closed handoff and enqueues the tap", async () => {
    seedWorld("LIVE");
    await inbound("salom");
    await openHandoff(String(conv().id), { reason: "wants_human", score: 0, thresholds: { warm: 30, hot: 60, veryHot: 80 }, alert: false });
    await hand();
    expect(state().handoffState).toBe("AI_ACTIVE");
    expect(state().context).toMatchObject({ campaignName: "Narx", executionId: "exec1", source: "trigger" });
    expect(conv().source).toBe("CAMPAIGN");
    expect(queues.enqueueJavobAiInbound).toHaveBeenCalledWith(expect.objectContaining({ messageId: "tap-exec1", source: "trigger" }));
  });

  it("never cuts an operator off: OPERATOR_ACTIVE (or the production hard mute) keeps the thread, the context is stored", async () => {
    seedWorld("LIVE");
    await inbound("salom");
    await openHandoff(String(conv().id), { reason: "wants_human", score: 0, thresholds: { warm: 30, hot: 60, veryHot: 80 }, alert: false });
    await acceptHandoff(String(conv().id), "telegram");
    const until = conv().operatorActiveUntil;
    await hand("exec2");
    expect(state().handoffState).toBe("OPERATOR_ACTIVE");
    expect(conv().operatorActiveUntil).toBe(until);
    expect(db.rows("aiHandoff")[0]).toMatchObject({ status: "ACCEPTED" });
    expect(state().context).toMatchObject({ executionId: "exec2", source: "trigger" });
    expect(queues.enqueueJavobAiInbound).not.toHaveBeenCalled();
    expect(db.rows("assistantEvent").find((e) => e.type === "jai_ai_action_operator_active")?.payload).toMatchObject({ executionId: "exec2" });

    // The inbox operator (production's hard mute only, AI state untouched).
    await closeHandoff(String(conv().id), "dev");
    conv().operatorActiveUntil = new Date(Date.now() + 3600_000);
    vi.clearAllMocks();
    await hand("exec3");
    expect(state().handoffState).toBe("CLOSED");
    expect(conv().operatorActiveUntil).toBeInstanceOf(Date);
    expect(queues.enqueueJavobAiInbound).not.toHaveBeenCalled();
  });
});

describe("SHADOW", () => {
  it("logs its reply next to production's without touching the conversation or the quota", async () => {
    seedWorld("SHADOW");
    // What production stored for this DM.
    const c = db.seed("conversation", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1", lastCustomerMessageAt: new Date() });
    db.seed("conversationMessage", { conversationId: c.id, mid: "m1", author: "CUSTOMER", text: "Divan narxi?" });
    db.seed("conversationMessage", { conversationId: c.id, mid: "p1", author: "ASSISTANT", text: "Milan 4 500 000 so'm." });
    setLlmProviderForTests(llm([{ reply: "Milan divani 4 500 000 so'm.", intent: "price_question", used_facts: ["P1"], extracted: { product: "Milan" } }]));
    db.log = [];

    await handleJavobAiInbound({ ...event("Divan narxi?", "m1"), shadow: true });
    expect(db.rows("aiShadowTurn")).toHaveLength(1);
    expect(db.rows("aiShadowTurn")[0]).toMatchObject({
      conversationId: "c1",
      customerText: "Divan narxi?",
      productionReply: "Milan 4 500 000 so'm.",
      aiReply: expect.stringContaining("Milan divani 4 500 000 so'm."),
      intent: "price_question",
      score: 25,
      handoff: null,
    });
    expect(db.rows("llmUsage")[0]).toMatchObject({ kind: "javobai_shadow" });
    expect(db.log.filter((l) => l.model === "conversation" || l.model === "conversationMessage")).toEqual([]);
    expect(db.rows("aiConversationState")).toHaveLength(0);
    expect(db.rows("workspace")[0].aiConversationsThisPeriod).toBe(0);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  it("a shadow job on an account that is no longer SHADOW is a no-op", async () => {
    seedWorld("LIVE");
    await handleJavobAiInbound({ ...event("salom", "m1"), shadow: true });
    expect(db.rows("aiShadowTurn")).toHaveLength(0);
  });
});

describe("knowledge preview and sandbox", () => {
  it("previewKnowledge lists the numbered lines (verified entries only)", async () => {
    seedWorld("LIVE");
    const preview = await previewKnowledge("w1", "a1");
    expect(preview.lines.map((l) => l.id)).toEqual(["B1", "B2", "B3", "P1", "K1"]);
    expect(preview.lines.find((l) => l.id === "K1")?.text).toContain("10% chegirma");
    expect(preview.truncated).toBe(false);
  });

  it("the sandbox runs the same turn and writes only its LlmUsage row", async () => {
    seedWorld("LIVE");
    setLlmProviderForTests(llm([{ reply: "Milan 4 500 000 so'm.", intent: "price_question", used_facts: ["P1"], extracted: { product: "Milan" } }]));
    db.log = [];
    const result = await runJavobAiSandbox("w1", {
      instagramAccountId: "a1",
      messages: [
        { role: "customer", text: "Salom" },
        { role: "assistant", text: "Salom! Qaysi mahsulot kerak?" },
        { role: "customer", text: "Milan divan narxi?" },
      ],
      contactState: { score: 5 },
    });
    expect(result.reply).toMatch(/^Milan 4 500 000 so'm\./);
    expect(result.intent).toBe("price_question");
    expect(result.usedFacts).toEqual(["P1"]);
    expect(result.signals.map((s) => s.signal).sort()).toEqual(["price_asked", "product_selected"]);
    expect(result.score).toBe(30);
    expect(result.temperature).toBe("WARM");
    expect(result.handoff.needed).toBe(false);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(db.log.map((l) => l.model)).toEqual(["llmUsage"]);
    expect(db.rows("llmUsage")[0]).toMatchObject({ kind: "javobai_sandbox", conversationId: null });
    expect(sendDirectMessage).not.toHaveBeenCalled();

    await expect(runJavobAiSandbox("other", { instagramAccountId: "a1", messages: [{ role: "customer", text: "x" }] })).rejects.toThrow();
  });
});
