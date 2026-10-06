import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("INSTAGRAM_APP_ID", "own-app-id");

const redisStore = vi.hoisted(() => new Map<string, string>());

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
  }),
}));
vi.mock("../lib/queue/assistant-queue", () => ({
  scheduleReply: vi.fn(async () => {}),
  enqueueDelivery: vi.fn(async () => {}),
  enqueueNotify: vi.fn(async () => {}),
}));
vi.mock("../lib/integrations/throttle", () => ({ acquireSlot: vi.fn(async () => {}) }));
vi.mock("../lib/meta/oauth", () => ({ decryptToken: (value: string) => value, encryptToken: (value: string) => value }));
vi.mock("../lib/meta/token-health", () => ({ markTokenBroken: vi.fn(async () => {}) }));
vi.mock("../lib/telegram/notify", () => ({
  alertWorkspace: vi.fn(async () => {}),
  sendWithRetry: vi.fn(async () => ({ message_id: 1 })),
  notifyWorkspaceChats: vi.fn(async () => 1),
}));
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

import { handleEcho, handleInboundMessage, markOperatorActiveForContact, runAssistantReply } from "../lib/assistant/engine";
import { setLlmProviderForTests, type LLMProvider } from "../lib/assistant/llm/provider";
import { DEBOUNCE_MS } from "../lib/assistant/humanize";
import { notifyCustomerWroteAgain } from "../lib/leads/service";
import { scheduleReply, enqueueDelivery, enqueueNotify } from "../lib/queue/assistant-queue";
import { sendDirectMessage, sendSenderAction } from "../lib/meta/client";
import { buildLeadWhere } from "../lib/leads/query";
import { db, resetDb } from "./helpers/db-instance";

type Row = Record<string, unknown>;

function llm(replies: Array<Partial<{ reply: string; name: string | null; product_interest: string | null; intent: string; summary: string | null }> | "throw">): LLMProvider {
  let i = 0;
  return {
    name: "fake",
    model: "fake",
    costUsd: () => 0.002,
    async complete() {
      const step = replies[Math.min(i++, replies.length - 1)];
      if (step === "throw") throw new Error("provider down");
      return {
        json: {
          reply: step.reply ?? "Tushundim.",
          extracted: { name: step.name ?? null, product_interest: step.product_interest ?? null, extra_field: null },
          intent: step.intent ?? "other",
          language: "uz_latn",
          summary: step.summary ?? null,
          unknown_question: null,
        },
        inputTokens: 120,
        outputTokens: 40,
        model: "fake",
        latencyMs: 30,
      };
    },
  };
}

function seedWorld(profile: Row = {}) {
  db.seed("workspace", { id: "w1", ownerId: "owner" });
  const account = db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "jamalxann", instagramId: "ig1", accessToken: "tok" });
  const p = db.seed("assistantProfile", {
    id: "p1", workspaceId: "w1", enabled: true, approvedAt: new Date(), companyName: "Mebel Plus",
    description: "Divan sotamiz", handleInboundDm: true, handleCampaignReplies: true, ...profile,
  });
  db.seed("assistantProduct", { profileId: "p1", name: "Milan", price: 4_500_000 });
  const tg = db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
  db.seed("telegramChat", { integrationId: tg.id, chatId: "-100" });
  return { account, profile: p };
}

const inbound = (text: string, mid = `m-${Math.random()}`, extra: Partial<Parameters<typeof handleInboundMessage>[0]> = {}) =>
  handleInboundMessage({ instagramAccountId: "ig1", senderId: "u1", messageId: mid, text, hasAttachment: false, ...extra });

const conv = () => db.rows("conversation")[0];
const sent = () => vi.mocked(sendDirectMessage).mock.calls.map((c) => c[3] as string);

/** Make the 4s debounce window look elapsed. */
function settle() {
  conv().lastCustomerMessageAt = new Date(Date.now() - 10_000);
}

beforeEach(() => {
  resetDb();
  redisStore.clear();
  vi.clearAllMocks();
  setLlmProviderForTests(llm([{ reply: "Assalomu alaykum! Ha, divanlarimiz bor. Qaysi turini qidiryapsiz?", product_interest: "divan" }]));
});

describe("inbound webhook handling", () => {
  it("stores the message, fills the profile and schedules ONE debounced reply (acceptance #3)", async () => {
    seedWorld();
    await inbound("salom");
    await inbound("divan bormi");
    await inbound("narxi qancha");
    expect(db.rows("conversationMessage")).toHaveLength(3);
    expect(conv().igUsername).toBe("aziz_ig");
    // every message re-arms the same 4s timer; the queue keeps only the last job
    expect(scheduleReply).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(scheduleReply).mock.calls) expect(call).toEqual([conv().id, DEBOUNCE_MS]);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  it("is idempotent for a redelivered webhook (same message id)", async () => {
    seedWorld();
    await inbound("salom", "m1");
    await inbound("salom", "m1");
    expect(db.rows("conversationMessage")).toHaveLength(1);
    expect(scheduleReply).toHaveBeenCalledTimes(1);
  });

  it("does nothing for inbound DMs when that rule is off", async () => {
    seedWorld({ handleInboundDm: false });
    await inbound("salom");
    expect(scheduleReply).not.toHaveBeenCalled();
  });

  it("does nothing while the profile is not approved", async () => {
    seedWorld({ approvedAt: null });
    await inbound("salom");
    expect(scheduleReply).not.toHaveBeenCalled();
  });

  it("stays out of the way when a keyword campaign answers the message", async () => {
    seedWorld();
    db.seed("automation", { instagramAccountId: "a1", isActive: true, dmTriggerEnabled: true, keywords: ["narx"], wholeWordMatch: true });
    await inbound("narx");
    expect(scheduleReply).not.toHaveBeenCalled();
  });

  it("a manual pause silences the bot", async () => {
    seedWorld();
    await inbound("salom", "m0");
    conv().botPaused = true;
    vi.mocked(scheduleReply).mockClear();
    await inbound("hello?", "m1");
    expect(scheduleReply).not.toHaveBeenCalled();
  });
});

describe("privacy: accounts without the assistant keep no records", () => {
  it("stores nothing for a stranger's DM when the assistant is off", async () => {
    seedWorld({ enabled: false });
    await inbound("salom, 90 123 45 67");
    expect(db.rows("conversation")).toHaveLength(0);
    expect(db.rows("conversationMessage")).toHaveLength(0);
    expect(vi.mocked(sendDirectMessage)).not.toHaveBeenCalled();
  });

  it("still keeps a campaign reply (so a typed number becomes a lead)", async () => {
    seedWorld({ enabled: false });
    const campaign = db.seed("automation", { id: "c1", name: "A", instagramAccountId: "a1" });
    db.seed("dmLog", { instagramAccountId: "a1", automationId: campaign.id, commenterId: "u1", status: "SENT", dmSentAt: new Date() });
    await inbound("90 123 45 67");
    expect(db.rows("lead")).toHaveLength(1);
  });
});

describe("conversation flow", () => {
  it("answers a greeting with typing indicators and moves to NEED", async () => {
    seedWorld();
    await inbound("Salom, divan bormi?");
    settle();
    await runAssistantReply(conv().id as string);

    expect(sent()).toEqual(["Assalomu alaykum! Ha, divanlarimiz bor. Qaysi turini qidiryapsiz?"]);
    expect(sent()[0].length).toBeLessThanOrEqual(300);
    expect(vi.mocked(sendSenderAction).mock.calls.map((c) => c[3])).toEqual(["mark_seen", "typing_on"]);
    expect(conv().assistantState).toBe("NEED");
    expect(conv().botMessageCount).toBe(1);
    expect(db.rows("conversationMessage").filter((m) => m.author === "ASSISTANT")).toHaveLength(1);
    expect(db.rows("llmUsage")).toHaveLength(1);
    expect(Number(db.rows("llmUsage")[0].inputTokens)).toBe(120);
  });

  it("a phone number in the first message captures a lead at once (acceptance #2)", async () => {
    seedWorld();
    setLlmProviderForTests(llm([{ name: "Aziz", intent: "gives_contact", summary: "Divan haqida so'radi", product_interest: "divan" }]));
    await inbound("Aziz 901234567");
    settle();
    await runAssistantReply(conv().id as string);

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("+998 90 123 45 67");
    expect(sent()[0]).toContain("Aziz");
    const lead = db.rows("lead")[0];
    expect(lead.phoneE164).toBe("+998901234567");
    expect(lead.name).toBe("Aziz");
    expect(lead.flag).toBeNull();
    expect(lead.productInterest).toBe("divan");
    expect(lead.transcript).toContain("Mijoz: Aziz");
    expect(lead.transcript).toContain("--- Suhbat ---");
    expect(conv().assistantState).toBe("HANDED_OFF");
    expect(db.rows("leadDelivery")).toHaveLength(1);
    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
  });

  it("walks NEW -> NEED -> CONTACT -> HANDED_OFF like the sample conversation", async () => {
    seedWorld();
    setLlmProviderForTests(
      llm([
        { reply: "Assalomu alaykum! Ha, divanlarimiz bor 🙂 Burchakli yoki to'g'ri?", product_interest: "divan" },
        { reply: "Tushundim. Ismingiz nima va qaysi raqamga bog'lanaylik?", product_interest: "burchakli kulrang divan" },
        { reply: "x", name: "Aziz", intent: "gives_contact", summary: "Burchakli kulrang divan qidiryapti." },
      ])
    );
    await inbound("Salom, sizlarda divan bormi?");
    settle();
    await runAssistantReply(conv().id as string);
    expect(conv().assistantState).toBe("NEED");

    await inbound("burchakli, kulrang");
    settle();
    await runAssistantReply(conv().id as string);
    expect(conv().assistantState).toBe("CONTACT");
    expect(conv().phoneAskCount).toBe(1);

    await inbound("Aziz, 90 123 45 67");
    settle();
    await runAssistantReply(conv().id as string);
    expect(conv().assistantState).toBe("HANDED_OFF");
    expect(sent()).toHaveLength(3);
    expect(conv().botMessageCount).toBeLessThanOrEqual(4);
    const lead = db.rows("lead")[0];
    expect(lead.name).toBe("Aziz");
    expect(lead.phoneE164).toBe("+998901234567");
    expect(lead.summary).toContain("kulrang");
    expect(lead.transcript as string).toContain("Assistent: Assalomu alaykum");
  });

  it("refusing the number twice ends in FALLBACK and a yellow no-phone lead (acceptance #4)", async () => {
    seedWorld();
    setLlmProviderForTests(llm([{ reply: "Menejer bog'lansin — raqamingizni qoldirasizmi?", product_interest: "divan", intent: "refuses_contact" }]));
    await inbound("divan kerak");
    settle();
    await runAssistantReply(conv().id as string); // NEED
    for (const text of ["yo'q", "raqam bermayman", "kerak emas"]) {
      await inbound(text);
      settle();
      await runAssistantReply(conv().id as string);
    }
    expect(conv().assistantState).toBe("HANDED_OFF");
    expect(conv().phoneAskCount).toBe(2); // never asked a third time
    const lead = db.rows("lead")[0];
    expect(lead.phoneE164).toBeNull();
    expect(lead.flag).toBe("no_phone");
    expect(lead.status).toBe("NEW");
    expect(sent().at(-1)).toMatch(/menejerimiz shu yerda/);
  });

  it("a thrown LLM error still gets the number from templates (acceptance #12)", async () => {
    seedWorld();
    setLlmProviderForTests(llm(["throw"]));
    await inbound("salom");
    settle();
    await runAssistantReply(conv().id as string);
    await inbound("divan");
    settle();
    await runAssistantReply(conv().id as string);
    await inbound("Ali 901112233");
    settle();
    await runAssistantReply(conv().id as string);
    expect(db.rows("lead")[0].phoneE164).toBe("+998901112233");
    expect(sent()).toHaveLength(3);
  });

  it("three LLM failures switch the workspace to template-only for 10 minutes", async () => {
    seedWorld();
    setLlmProviderForTests(llm(["throw"]));
    for (const text of ["salom", "divan", "kerak"]) {
      await inbound(text);
      settle();
      await runAssistantReply(conv().id as string);
    }
    const ws = db.rows("workspace")[0];
    const until = ws.assistantTemplateOnlyUntil as Date;
    expect(until.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(db.rows("assistantEvent").some((e) => e.type === "template_mode")).toBe(true);
  });

  it("an exhausted AI-conversation quota still collects numbers from templates", async () => {
    seedWorld();
    db.rows("workspace")[0].aiConversationsLimit = 5;
    db.rows("workspace")[0].aiConversationsThisPeriod = 5;
    const provider = llm([{ reply: "LLM reply" }]);
    const spy = vi.spyOn(provider, "complete");
    setLlmProviderForTests(provider);
    await inbound("salom");
    settle();
    await runAssistantReply(conv().id as string);
    expect(spy).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).not.toBe("LLM reply");
  });

  it("counts an AI conversation only once, on the first bot message", async () => {
    seedWorld();
    await inbound("salom");
    settle();
    await runAssistantReply(conv().id as string);
    await inbound("divan");
    settle();
    await runAssistantReply(conv().id as string);
    expect(db.rows("workspace")[0].aiConversationsThisPeriod).toBe(1);
  });
});

describe("blocked output", () => {
  it("replaces a priced reply under price_policy=never and logs the event (acceptance #6)", async () => {
    seedWorld();
    setLlmProviderForTests(llm([{ reply: "Milan divani 4 500 000 so'm turadi." }]));
    await inbound("narxi qancha?");
    settle();
    await runAssistantReply(conv().id as string);
    expect(sent()[0]).not.toMatch(/4 500 000/);
    expect(db.rows("assistantEvent").find((e) => e.type === "blocked_reply")?.payload).toMatchObject({ reason: "price_forbidden" });
  });

  it("allows the listed price with price_policy=exact (acceptance #19)", async () => {
    seedWorld({ pricePolicy: "EXACT" });
    setLlmProviderForTests(llm([{ reply: "Milan divani 4 500 000 so'm. Ismingiz va raqamingiz?", intent: "price_question" }]));
    await inbound("Milan narxi?");
    settle();
    await runAssistantReply(conv().id as string);
    expect(sent()[0]).toContain("4 500 000");
  });

  it("an unknown product price is blocked even with exact policy (acceptance #19)", async () => {
    seedWorld({ pricePolicy: "EXACT" });
    setLlmProviderForTests(llm([{ reply: "Oslo divani 2 000 000 so'm." }]));
    await inbound("Oslo narxi?");
    settle();
    await runAssistantReply(conv().id as string);
    expect(sent()[0]).not.toContain("2 000 000");
  });
});

describe("operator takeover (TZ section 5)", () => {
  it("an echo from the Instagram app pauses the bot for 24h (acceptance #5)", async () => {
    seedWorld();
    await inbound("salom");
    await handleEcho({ instagramAccountId: "ig1", customerId: "u1", messageId: "echo-1", text: "Salom, men operatorman", appId: null });

    const until = conv().operatorActiveUntil as Date;
    expect(until.getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(until.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 1000);
    expect(db.rows("conversationMessage").some((m) => m.author === "OPERATOR")).toBe(true);
    expect(db.rows("assistantEvent").some((e) => e.type === "operator_takeover")).toBe(true);

    settle();
    await runAssistantReply(conv().id as string);
    expect(sendDirectMessage).not.toHaveBeenCalled();

    vi.mocked(scheduleReply).mockClear();
    await inbound("narxi qancha", "m-next");
    expect(scheduleReply).not.toHaveBeenCalled();
  });

  it("echoes of our own app (campaign DMs, assistant replies) are not an operator", async () => {
    seedWorld();
    await inbound("salom");
    await handleEcho({ instagramAccountId: "ig1", customerId: "u1", messageId: "echo-2", text: "kampaniya DM", appId: "own-app-id" });
    expect(conv().operatorActiveUntil).toBeNull();
  });

  it("an echo right after our own campaign DM is never an operator, even with an unknown app id", async () => {
    seedWorld();
    await inbound("salom");
    const campaign = db.seed("automation", { id: "c1", name: "A", instagramAccountId: "a1" });
    db.seed("dmLog", { instagramAccountId: "a1", automationId: campaign.id, commenterId: "u1", status: "SENT", dmSentAt: new Date() });
    await handleEcho({ instagramAccountId: "ig1", customerId: "u1", messageId: "echo-x", text: "kampaniya", appId: "some-other-id" });
    expect(conv().operatorActiveUntil).toBeNull();
  });

  it("an echo of a message we stored ourselves is ignored", async () => {
    seedWorld();
    await inbound("salom");
    settle();
    await runAssistantReply(conv().id as string);
    const mid = db.rows("conversationMessage").find((m) => m.author === "ASSISTANT")!.mid as string;
    await handleEcho({ instagramAccountId: "ig1", customerId: "u1", messageId: mid, text: "x", appId: null });
    expect(conv().operatorActiveUntil).toBeNull();
  });

  it("honours the configured pause length", async () => {
    seedWorld({ operatorPauseHours: 2 });
    await inbound("salom");
    await handleEcho({ instagramAccountId: "ig1", customerId: "u1", messageId: "echo-3", text: "hi", appId: null });
    const ms = (conv().operatorActiveUntil as Date).getTime() - Date.now();
    expect(ms).toBeGreaterThan(1.9 * 3600_000);
    expect(ms).toBeLessThanOrEqual(2 * 3600_000 + 1000);
  });

  it("answering from the SocialAuto inbox pauses the bot too", async () => {
    seedWorld();
    await inbound("salom");
    await markOperatorActiveForContact("a1", "u1", "Salom, operator yozmoqda", "mid-op");
    expect(conv().operatorActiveUntil).not.toBeNull();
    expect(db.rows("conversationMessage").some((m) => m.author === "OPERATOR")).toBe(true);
  });

  it("an operator who replies during the typing delay wins", async () => {
    seedWorld();
    await inbound("salom");
    settle();
    const provider = llm([{ reply: "Salom!" }]);
    const original = provider.complete.bind(provider);
    provider.complete = async (request) => {
      const result = await original(request);
      // the operator answers while the model is "thinking"
      conv().operatorActiveUntil = new Date(Date.now() + 3600_000);
      return result;
    };
    setLlmProviderForTests(provider);
    await runAssistantReply(conv().id as string);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("Meta 24-hour window (acceptance #9)", () => {
  it("never sends when the customer's last message is older than 24h", async () => {
    seedWorld();
    await inbound("salom");
    conv().lastCustomerMessageAt = new Date(Date.now() - 25 * 3600_000);
    await runAssistantReply(conv().id as string);
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect(db.rows("assistantEvent").some((e) => e.type === "window_closed")).toBe(true);
  });
});

describe("hand-off and restarts", () => {
  async function handedOff() {
    seedWorld();
    setLlmProviderForTests(llm([{ name: "Aziz", intent: "gives_contact" }]));
    await inbound("Aziz 901234567");
    settle();
    await runAssistantReply(conv().id as string);
    vi.mocked(sendDirectMessage).mockClear();
    vi.mocked(scheduleReply).mockClear();
  }

  it("stays silent after hand-off and notifies the operators at most once per 5 minutes", async () => {
    await handedOff();
    await inbound("yana bir savol", "m-a");
    await inbound("hello?", "m-b");
    expect(scheduleReply).not.toHaveBeenCalled();
    expect(enqueueNotify).toHaveBeenCalledTimes(1);
    expect(enqueueNotify).toHaveBeenCalledWith({ kind: "customer_wrote_again", conversationId: conv().id });

    conv().lastNotifiedAt = new Date(Date.now() - 6 * 60_000);
    await notifyCustomerWroteAgain(conv().id as string);
    expect(enqueueNotify).toHaveBeenCalledTimes(2);
  });

  it("optionally sends one short reply after hand-off", async () => {
    await handedOff();
    db.rows("assistantProfile")[0].postHandoffReply = true;
    await inbound("yana savol", "m-c");
    expect(scheduleReply).toHaveBeenCalledTimes(1);
    settle();
    await runAssistantReply(conv().id as string);
    expect(sent()).toHaveLength(1);
    await inbound("yana", "m-d");
    settle();
    await runAssistantReply(conv().id as string);
    expect(sent()).toHaveLength(1); // only one
  });

  it("a new conversation starts 30 days later, linked by lead dedup", async () => {
    await handedOff();
    conv().lastCustomerMessageAt = new Date(Date.now() - 31 * 24 * 3600_000);
    await inbound("Salom yana", "m-new");
    expect(conv().assistantState).toBe("NEW");
    expect(conv().leadCycle).toBe(1);
    expect(conv().botMessageCount).toBe(0);
  });
});

describe("campaign replies (trigger A) and phase-1 capture", () => {
  it("a reply to a campaign DM is handed to the assistant and the lead carries the campaign", async () => {
    seedWorld();
    const campaign = db.seed("automation", { id: "camp1", name: "Divan aksiyasi", postUrl: "https://instagram.com/p/xxx", instagramAccountId: "a1", handoffToAssistant: true });
    db.seed("dmLog", { instagramAccountId: "a1", automationId: campaign.id, commenterId: "u1", status: "SENT", dmSentAt: new Date(Date.now() - 3600_000), matchedKeyword: "NARX" });
    setLlmProviderForTests(llm([{ name: "Aziz", intent: "gives_contact" }]));

    await inbound("Aziz 901234567");
    expect(conv().source).toBe("CAMPAIGN");
    expect(conv().campaignId).toBe("camp1");
    settle();
    await runAssistantReply(conv().id as string);

    const lead = db.rows("lead")[0];
    expect(lead.source).toBe("CAMPAIGN");
    expect(lead.campaignName).toBe("Divan aksiyasi");
    expect(lead.triggerKeyword).toBe("NARX");
    expect(lead.postUrl).toBe("https://instagram.com/p/xxx");
    expect(lead.transcript as string).toContain('Kampaniya "Divan aksiyasi"');
    expect(lead.transcript as string).toContain("kalit so'z: NARX");
  });

  it("campaign replies are ignored when the campaign did not enable the hand-off but inbound DMs are off", async () => {
    seedWorld({ handleInboundDm: false });
    const campaign = db.seed("automation", { id: "camp1", name: "A", instagramAccountId: "a1", handoffToAssistant: false });
    db.seed("dmLog", { instagramAccountId: "a1", automationId: campaign.id, commenterId: "u1", status: "SENT", dmSentAt: new Date() });
    await inbound("salom");
    expect(scheduleReply).not.toHaveBeenCalled();
  });

  it("without an assistant, a phone typed after a campaign DM still becomes a lead (stage 1)", async () => {
    seedWorld({ enabled: false });
    const campaign = db.seed("automation", { id: "camp1", name: "Divan aksiyasi", instagramAccountId: "a1" });
    db.seed("dmLog", { instagramAccountId: "a1", automationId: campaign.id, commenterId: "u1", status: "SENT", dmSentAt: new Date() });
    await inbound("90 123 45 67");
    expect(sendDirectMessage).not.toHaveBeenCalled();
    const lead = db.rows("lead")[0];
    expect(lead.phoneE164).toBe("+998901234567");
    expect(lead.campaignName).toBe("Divan aksiyasi");
    expect(db.rows("leadDelivery")).toHaveLength(1);
  });

  it("no lead from a stranger's number when there was no campaign DM", async () => {
    seedWorld({ enabled: false });
    await inbound("90 123 45 67");
    expect(db.rows("lead")).toHaveLength(0);
  });
});

describe("lead dedup and tenant isolation", () => {
  it("the same phone within 30 days becomes a repeat lead (acceptance #11)", async () => {
    seedWorld();
    setLlmProviderForTests(llm([{ name: "Aziz", intent: "gives_contact" }]));
    await inbound("Aziz 901234567");
    settle();
    await runAssistantReply(conv().id as string);

    // a second customer account, same phone, same workspace
    await handleInboundMessage({ instagramAccountId: "ig1", senderId: "u2", messageId: "m-u2", text: "Aziz 90 123 45 67", hasAttachment: false });
    const second = db.rows("conversation").find((c) => c.igUserId === "u2")!;
    second.lastCustomerMessageAt = new Date(Date.now() - 10_000);
    await runAssistantReply(second.id as string);

    const leads = db.rows("lead");
    expect(leads).toHaveLength(2);
    expect(leads[1].isRepeat).toBe(true);
    expect(leads[1].repeatOfId).toBe(leads[0].id);
    expect(leads[0].repeatCount).toBe(1);
    const kinds = db.rows("leadDelivery").map((d) => d.kind);
    expect(kinds).toEqual(["new", "repeat"]);
  });

  it("a number older than 30 days is a fresh lead", async () => {
    seedWorld();
    db.seed("lead", { id: "old", workspaceId: "w1", instagramAccountId: "a1", idempotencyKey: "old:0", igUserId: "u0", phoneE164: "+998901234567", createdAt: new Date(Date.now() - 31 * 24 * 3600_000) });
    setLlmProviderForTests(llm([{ name: "Aziz", intent: "gives_contact" }]));
    await inbound("Aziz 901234567");
    settle();
    await runAssistantReply(conv().id as string);
    expect(db.rows("lead").at(-1)!.isRepeat).toBe(false);
  });

  it("another workspace's lead never counts as a duplicate, and never shows up in a list (acceptance #13)", async () => {
    seedWorld();
    db.seed("lead", { id: "foreign", workspaceId: "w2", instagramAccountId: "aX", idempotencyKey: "f:0", igUserId: "uf", phoneE164: "+998901234567" });
    setLlmProviderForTests(llm([{ name: "Aziz", intent: "gives_contact" }]));
    await inbound("Aziz 901234567");
    settle();
    await runAssistantReply(conv().id as string);

    const mine = db.rows("lead").find((l) => l.workspaceId === "w1")!;
    expect(mine.isRepeat).toBe(false);
    const visible = await db.model("lead").findMany({ where: buildLeadWhere("w1", {}) as never });
    expect(visible.map((l) => l.workspaceId)).toEqual(["w1"]);
    const search = await db.model("lead").findMany({ where: buildLeadWhere("w2", { q: "998901234567" }) as never });
    expect(search.map((l) => l.id)).toEqual(["foreign"]);
  });

  it("creates exactly one lead per conversation even if the reply job runs twice", async () => {
    seedWorld();
    setLlmProviderForTests(llm([{ name: "Aziz", intent: "gives_contact" }]));
    await inbound("Aziz 901234567");
    settle();
    await runAssistantReply(conv().id as string);
    const { createLeadForConversation } = await import("../lib/leads/service");
    await createLeadForConversation(conv().id as string);
    expect(db.rows("lead")).toHaveLength(1);
  });
});
