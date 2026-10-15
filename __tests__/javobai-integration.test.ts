/**
 * ETAP 4.2–4.4 wired into the engine, against the in-memory database:
 * multilingual retrieval + reply instruction, rolling summary / compaction /
 * contact memory across the 30-day cycle, voice notes (Gemini STT) and photos
 * (vision) at inbound time, and the workspace budget (hard stop, soft caps,
 * model routing, usage kinds).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  alertWorkspace: vi.fn(async () => {}),
  sendEmail: vi.fn(async () => {}),
}));
/** Model ids the engine asked `getLlmProviderFor` for (routing under the budget). */
const routed = vi.hoisted(() => ({ models: [] as Array<string | undefined> }));

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
    decr: async (key: string) => {
      const next = Number(redisStore.get(key) ?? 0) - 1;
      redisStore.set(key, String(next));
      return next;
    },
    expire: async () => 1,
    pexpire: async () => 1,
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
  alertWorkspace: queues.alertWorkspace,
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
vi.mock("../lib/assistant/llm/provider", async (original) => {
  const mod = await original<typeof import("../lib/assistant/llm/provider")>();
  return {
    ...mod,
    getLlmProviderFor: (model?: string) => {
      routed.models.push(model);
      return mod.getLlmProviderFor(model);
    },
  };
});
// The media download guards resolve the CDN host; never hit real DNS here.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));

import { setLlmProviderForTests, type LLMProvider, type LlmRequest } from "../lib/assistant/llm/provider";
import { setSttProviderForTests } from "../lib/assistant/stt";
import { forgetJavobAiGate } from "../lib/javobai/gate";
import { handleJavobAiInbound, runJavobAiReply } from "../lib/javobai/runtime";
import { tashkentMonthStart } from "../lib/javobai/usage";
import { sendDirectMessage } from "../lib/meta/client";
import { db, resetDb } from "./helpers/db-instance";

type Row = Record<string, unknown>;
type Out = Partial<{
  reply: string;
  intent: string;
  confidence: number;
  used_facts: string[];
  extracted: Record<string, string | null>;
  unknown_question: string | null;
  memory_note: string | null;
}>;

const requests: LlmRequest[] = [];
const replyRequests = () => requests.filter((r) => r.schemaName === "javobai_reply");

function llm(outputs: Out[], extra: { vision?: unknown; compaction?: string | Error } = {}): LLMProvider {
  let i = 0;
  return {
    name: "fake",
    model: "gemini-2.5-flash",
    costUsd: (inp, out) => (inp * 0.3 + out * 2.5) / 1_000_000,
    async complete(request) {
      requests.push(request);
      if (request.schemaName === "javobai_vision") {
        return {
          json: extra.vision ?? { description: "Kulrang divan", matched_product_ids: ["P1"], confidence: 0.9, question_for_customer: null },
          inputTokens: 1200,
          outputTokens: 60,
          model: "gemini-smart",
          latencyMs: 5,
        };
      }
      if (request.schemaName === "compact_summary") {
        if (extra.compaction instanceof Error) throw extra.compaction;
        return { json: { summary: extra.compaction ?? "Qisqa xulosa" }, inputTokens: 300, outputTokens: 40, model: "gemini-2.5-flash", latencyMs: 5 };
      }
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
          memory_note: step.memory_note ?? null,
        },
        inputTokens: 1000,
        outputTokens: 100,
        model: "gemini-2.5-flash",
        latencyMs: 20,
      };
    },
  };
}

function seedWorld(options: { products?: string[]; faqs?: number } = {}) {
  db.seed("workspace", { id: "w1", ownerId: "owner" });
  db.seed("user", { id: "owner", email: "owner@mebel.uz" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "mebel", instagramId: "ig1", accessToken: "tok" });
  db.seed("assistantProfile", {
    id: "p1", workspaceId: "w1", enabled: true, approvedAt: new Date(), companyName: "Mebel Plus",
    description: "Divan va kreslolar", pricePolicy: "EXACT", delivery: "Toshkent bo'ylab bepul", handleInboundDm: true,
  });
  for (const [i, name] of (options.products ?? ["Milan"]).entries()) db.seed("assistantProduct", { profileId: "p1", name, price: 4_500_000, sort: i });
  for (let i = 0; i < (options.faqs ?? 0); i++) db.seed("assistantFaq", { profileId: "p1", question: `Savol ${i}`, answer: "x".repeat(400), sort: i });
  const tg = db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
  db.seed("telegramChat", { integrationId: tg.id, chatId: "-100" });
  db.seed("javobAiAccount", { workspaceId: "w1", instagramAccountId: "a1", mode: "LIVE", config: {} });
}

function seedBudget(soft: number, hard: number | null, spentUsd: number) {
  db.seed("aiBudget", { workspaceId: "w1", monthlyUsdSoft: soft, monthlyUsdHard: hard, periodStart: tashkentMonthStart(), alerted50At: null, alerted80At: null, alerted100At: null });
  db.seed("llmUsage", { workspaceId: "w1", kind: "reply", model: "m", inputTokens: 1, outputTokens: 1, costUsd: spentUsd, latencyMs: 1, ok: true });
}

const event = (text: string, mid = `m-${Math.random()}`) => ({ instagramAccountId: "ig1", senderId: "u1", messageId: mid, text, hasAttachment: false });
const inbound = (text: string, extra: Partial<Parameters<typeof handleJavobAiInbound>[0]> = {}) =>
  handleJavobAiInbound({ ...event(text), shadow: false, source: "webhook", ...extra });
const conv = () => db.rows("conversation")[0];
const state = () => db.rows("aiConversationState")[0];
const sent = () => vi.mocked(sendDirectMessage).mock.calls.map((c) => c[3] as string);
const usageKinds = () => db.rows("llmUsage").map((u) => u.kind);
const settle = () => {
  conv().lastCustomerMessageAt = new Date(Date.now() - 10_000);
};
async function say(text: string, extra: Partial<Parameters<typeof handleJavobAiInbound>[0]> = {}) {
  await inbound(text, extra);
  settle();
  await runJavobAiReply(String(conv().id));
}

// ─── Media fixtures ──────────────────────────────────────────────────────────

const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)]);
const CDN_AUDIO = "https://cdn.example.com/voice.ogg?sig=secret-token";
const CDN_IMAGE = "https://cdn.example.com/photo.jpg?sig=secret-token";

function geminiTranscript(text: string, confidence: number) {
  return {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ text, language: "uz", confidence }) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 25, totalTokenCount: 325 },
  };
}

function stubMedia(opts: { bytes: Buffer; contentType: string; gemini?: unknown }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify(opts.gemini ?? {}), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(new Uint8Array(opts.bytes), { status: 200, headers: { "content-type": opts.contentType, "content-length": String(opts.bytes.length) } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetDb();
  redisStore.clear();
  requests.length = 0;
  routed.models.length = 0;
  vi.clearAllMocks();
  vi.stubEnv("JAVOBAI_DISABLED", "");
  vi.stubEnv("JAVOBAI_MODEL", "");
  vi.stubEnv("JAVOBAI_MODEL_SMART", "");
  vi.stubEnv("JAVOBAI_STT_MODEL", "");
  vi.stubEnv("LLM_API_KEY", "k");
  vi.stubEnv("LLM_MODEL", "gemini-2.5-flash");
  vi.stubEnv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai");
  vi.stubEnv("GEMINI_NATIVE_BASE_URL", "");
  vi.stubEnv("STT_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  setSttProviderForTests(null); // Whisper off: Gemini is the STT
  forgetJavobAiGate();
  setLlmProviderForTests(llm([{ reply: "Tushundim." }]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSttProviderForTests(undefined);
});

// ─── 4.2 Multilingual + memory ───────────────────────────────────────────────

describe("4.2 multilingual", () => {
  it("a Cyrillic customer gets the Cyrillic reply instruction and the Latin catalog match", async () => {
    const products = [...Array.from({ length: 15 }, (_, i) => `Kreslo ${i}`), "Divan Milan"];
    seedWorld({ products });
    setLlmProviderForTests(llm([{ reply: "Диван Милан 4 500 000 сўм.", intent: "price_question", used_facts: ["P1"], extracted: { product: "Divan Milan" } }]));

    await say("Диван Милан нархи канча?");
    const system = replyRequests()[0].system;
    expect(system).toContain("JAVOB TILI: o'zbek tili, KIRILL yozuvi");
    expect(system).toContain("P1: Divan Milan");
    expect(system).not.toContain("P16:");
    expect(sent()[0]).toMatch(/^Диван Милан 4 500 000 сўм\./);
    expect(conv().collected).toMatchObject({ language: "uz_cyrl" });
    expect(db.rows("aiContactMemory")[0].facts).toMatchObject({ language: "uz_cyrl", pastInterests: ["Divan Milan"] });
    // Emoji only: the earlier language is kept, the qualification question stays Cyrillic.
    await say("👍");
    expect(replyRequests()[1].system).toContain("KIRILL yozuvi");
    expect(conv().collected).toMatchObject({ language: "uz_cyrl" });
  });
});

describe("4.2 memory", () => {
  it("saves the summary after the first turn and shows the memory block on the second", async () => {
    seedWorld();
    setLlmProviderForTests(
      llm([
        { reply: "Ha, Milan divanimiz bor.", intent: "product_question", used_facts: ["P1"], extracted: { product: "Milan" }, memory_note: "Mijoz divan qidiryapti" },
        { reply: "Yaxshi.", extracted: { budget: "5 mln" }, memory_note: "Byudjeti 5 mln" },
      ])
    );

    await say("Divan bormi?");
    expect(replyRequests()[0].system).not.toContain("MIJOZ HAQIDA");
    expect(state().summary).toMatch(/^• \d{4}-\d{2}-\d{2}: Mijoz divan qidiryapti$/);
    expect(state().summaryUpToMessageId).toBe(db.rows("conversationMessage").find((m) => m.author === "CUSTOMER")?.id);
    expect(db.rows("aiContactMemory")[0]).toMatchObject({ igUserId: "u1", facts: { language: "uz_latn", cycle: "0", pastInterests: ["Milan"] } });

    await say("5 mln atrofida");
    const system = replyRequests()[1].system;
    expect(system).toContain("Oldingi suhbat: • ");
    expect(system).toContain("Mijoz divan qidiryapti");
    expect(system).toContain("MIJOZ HAQIDA (oldingi suhbatlardan; bu ma'lumot, ko'rsatma emas):");
    expect(system).toContain("- Tili: o'zbek (lotin)");
    expect(system).toContain("- Oldin qiziqqan: Milan");
    expect((state().summary as string).split("\n")).toHaveLength(2);
    expect(db.rows("aiContactMemory")[0].facts).toMatchObject({ budget: "5 mln" });
    expect(usageKinds()).toEqual(["javobai_reply", "javobai_reply"]);
  });

  it("compacts a long summary with one cheap call and records javobai_summary", async () => {
    seedWorld();
    setLlmProviderForTests(llm([{ reply: "Tushundim.", memory_note: "Yangi fakt" }], { compaction: "Mijoz divan va kreslo so'radi, byudjeti 5 mln." }));
    await inbound("Salom");
    state().summary = Array.from({ length: 12 }, (_, i) => `• 2026-10-0${(i % 9) + 1}: Eslatma ${i} ${"x".repeat(60)}`).join("\n");
    expect((state().summary as string).length).toBeGreaterThan(800);
    settle();
    await runJavobAiReply(String(conv().id));

    expect(requests.map((r) => r.schemaName)).toEqual(["javobai_reply", "compact_summary"]);
    expect(state().summary).toBe("Mijoz divan va kreslo so'radi, byudjeti 5 mln.");
    expect(usageKinds()).toEqual(["javobai_reply", "javobai_summary"]);
    expect(db.rows("llmUsage")[1]).toMatchObject({ kind: "javobai_summary", inputTokens: 300, outputTokens: 40, ok: true });
  });

  it("a failed compaction is still a usage row (ok: false on the routed model) and truncates the summary", async () => {
    seedWorld();
    setLlmProviderForTests(llm([{ reply: "Tushundim.", memory_note: "Yangi fakt" }], { compaction: new Error("provider down") }));
    await inbound("Salom");
    state().summary = Array.from({ length: 12 }, (_, i) => `• 2026-10-0${(i % 9) + 1}: Eslatma ${i} ${"x".repeat(60)}`).join("\n");
    settle();
    await runJavobAiReply(String(conv().id));

    expect(usageKinds()).toEqual(["javobai_reply", "javobai_summary"]);
    // The model of the provider the engine routed the call to (here the fake provider's own id).
    expect(db.rows("llmUsage")[1]).toMatchObject({ kind: "javobai_summary", model: "gemini-2.5-flash", inputTokens: 0, outputTokens: 0, ok: false });
    expect(Number(db.rows("llmUsage")[1].costUsd)).toBe(0);
    expect(db.rows("assistantEvent").find((e) => e.type === "jai_summary_compaction_failed")?.payload).toMatchObject({ error: "provider down" });
    expect((state().summary as string).length).toBeLessThan(800);
    expect(state().summary).toContain("Yangi fakt");
  });

  it("a contact coming back after the 30-day cycle is recognised (returning_contact, last summary)", async () => {
    seedWorld();
    setLlmProviderForTests(
      llm([
        { reply: "Ha, Milan bor.", intent: "product_question", used_facts: ["P1"], extracted: { product: "Milan" }, memory_note: "Mijoz Milan divanini so'radi" },
        { reply: "Xush kelibsiz!", intent: "greeting" },
      ])
    );
    await say("Milan divan bormi?");
    expect(db.rows("aiScoreEvent").map((e) => e.signal)).toEqual(["product_selected"]);

    // 31 days of silence: a new lead cycle, the state starts over, memory carries over.
    conv().lastCustomerMessageAt = new Date(Date.now() - 31 * 24 * 3600_000);
    await say("Salom, yana keldim");
    expect(conv().leadCycle).toBe(1);
    expect(state()).toMatchObject({ leadCycle: 1, turns: 1 });
    const memory = db.rows("aiContactMemory")[0] as Row;
    expect(memory.lastSummary).toContain("Mijoz Milan divanini so'radi");
    expect(db.rows("aiScoreEvent").filter((e) => e.leadCycle === 1).map((e) => e.signal)).toEqual(["returning_contact"]);
    const system = replyRequests()[1].system;
    expect(system).toContain("MIJOZ HAQIDA (oldingi suhbatlardan");
    expect(system).toContain("- Oldin qiziqqan: Milan");
    expect(system).toContain("- Oldingi suhbat xulosasi: • ");
    expect(system).not.toContain("Oldingi suhbat: • "); // the new cycle's own summary is empty
    expect(memory.facts).toMatchObject({ cycle: "1" });
  });
});

// ─── 4.3 Voice + image ───────────────────────────────────────────────────────

describe("4.3 voice", () => {
  const voiceJob = { text: "", hasAttachment: true, attachments: [{ type: "audio", url: CDN_AUDIO }] };

  it("a voice note is downloaded, transcribed by Gemini and answered as a normal turn", async () => {
    seedWorld();
    const fetchMock = stubMedia({ bytes: OGG, contentType: "audio/ogg", gemini: geminiTranscript("Divan narxi qancha?", 0.9) });
    setLlmProviderForTests(llm([{ reply: "Milan 4 500 000 so'm.", intent: "price_question", used_facts: ["P1"], extracted: { product: "Milan" } }]));

    await say("", voiceJob);
    const customer = db.rows("conversationMessage").find((m) => m.author === "CUSTOMER") as Row;
    expect(customer.text).toBe("🎤 Divan narxi qancha?");
    expect(customer.llmMeta).toMatchObject({ javobai: true, media: [{ kind: "audio", outcome: "transcribed", provider: "gemini", confidence: 0.9 }] });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([CDN_AUDIO, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"]);
    expect(replyRequests()[0].messages.at(-1)?.content).toBe("🎤 Divan narxi qancha?");
    expect(sent()[0]).toMatch(/^Milan 4 500 000 so'm\./);
    expect(usageKinds()).toEqual(["javobai_stt", "javobai_reply"]);
    expect(db.rows("llmUsage")[0]).toMatchObject({ kind: "javobai_stt", model: "gemini-2.5-flash", inputTokens: 300, outputTokens: 25, ok: true });
    expect(redisStore.has(`conv:${conv().id}:lock`)).toBe(false);
    expect(db.rows("assistantEvent").map((e) => e.type)).toContain("jai_voice_transcribed");
    // No url / bytes anywhere in what was stored.
    expect(JSON.stringify(db.rows("assistantEvent"))).not.toContain("secret-token");
    expect(JSON.stringify(db.rows("conversationMessage"))).not.toContain("secret-token");
  });

  it("a low-confidence voice note gets the 'please write it' template and no model call", async () => {
    seedWorld();
    stubMedia({ bytes: OGG, contentType: "audio/ogg", gemini: geminiTranscript("mmm", 0.2) });
    await say("", voiceJob);
    const customer = db.rows("conversationMessage").find((m) => m.author === "CUSTOMER") as Row;
    expect(customer.text).toBe("[ovozli xabar]");
    expect(customer.llmMeta).toMatchObject({ media: [{ kind: "audio", outcome: "unclear" }] });
    expect(sent()).toEqual(["Ovozli xabarni tushunolmadim, iltimos yozib yuboring 🙏"]);
    expect(replyRequests()).toHaveLength(0);
    expect(usageKinds()).toEqual(["javobai_stt"]);
    expect(db.rows("conversationMessage").find((m) => m.author === "ASSISTANT")?.llmMeta).toMatchObject({ voiceUnclear: true, usedTemplate: true });
    expect(state().turns).toBe(0);
  });

  it("a download failure is a failed STT row and the same template; the cap skips the 4th note", async () => {
    seedWorld();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await say("", voiceJob);
    expect(sent()[0]).toMatch(/Ovozli xabarni tushunolmadim/);
    expect(db.rows("llmUsage")).toHaveLength(1);
    expect(db.rows("llmUsage")[0]).toMatchObject({ kind: "javobai_stt", ok: false, inputTokens: 0 });

    redisStore.set(`javobai:media:${conv().id}`, "3");
    const fetchMock = stubMedia({ bytes: OGG, contentType: "audio/ogg", gemini: geminiTranscript("Salom", 0.9) });
    await say("", voiceJob);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.rows("assistantEvent").filter((e) => e.type === "jai_media_skipped")).toHaveLength(1);
    expect(sent()).toHaveLength(2);
  });

  it("a media job that outlived the lock TTL releases only its own token, never a reply job's lock", async () => {
    seedWorld();
    let lockKey = "";
    let seenDuringDownload: string | undefined;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify(geminiTranscript("Salom", 0.9)), { status: 200, headers: { "content-type": "application/json" } });
      }
      // The TTL expires while the note downloads and another reply job takes the lock.
      lockKey = `conv:${conv().id}:lock`;
      seenDuringDownload = redisStore.get(lockKey);
      redisStore.set(lockKey, "another-reply-job");
      return new Response(new Uint8Array(OGG), { status: 200, headers: { "content-type": "audio/ogg", "content-length": String(OGG.length) } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await inbound("", voiceJob);
    expect(seenDuringDownload).toMatch(/^[0-9a-f-]{36}$/); // the media job held it with its own token
    expect(seenDuringDownload).not.toBe("1");
    expect(redisStore.get(lockKey)).toBe("another-reply-job"); // left alone
    expect(db.rows("conversationMessage")[0]).toMatchObject({ text: "🎤 Salom" });

    // A reply job releases its own lock as before.
    redisStore.delete(lockKey);
    settle();
    await runJavobAiReply(String(conv().id));
    expect(sent()).toHaveLength(1);
    expect(redisStore.has(lockKey)).toBe(false);
  });
});

describe("4.3 image", () => {
  const photoJob = { text: "", hasAttachment: true, attachments: [{ type: "image", url: CDN_IMAGE }] };

  it("a photo is described on the smart model, the note reaches the prompt and the match grounds the answer", async () => {
    vi.stubEnv("JAVOBAI_MODEL_SMART", "gemini-smart");
    seedWorld();
    stubMedia({ bytes: JPEG, contentType: "image/jpeg" });
    setLlmProviderForTests(llm([{ reply: "Ha, bu bizning Milan divanimiz.", intent: "product_question", used_facts: [] }]));

    await say("", photoJob);
    const customer = db.rows("conversationMessage").find((m) => m.author === "CUSTOMER") as Row;
    expect(customer.text).toBe("[rasm/fayl]");
    expect(customer.llmMeta).toMatchObject({
      media: [{ kind: "image", outcome: "answer_from_catalog", confidence: 0.9, matches: [{ id: "P1", name: "Milan" }] }],
    });
    const vision = requests.find((r) => r.schemaName === "javobai_vision")!;
    expect(vision.images?.[0]).toMatchObject({ mediaType: "image/jpeg" });
    expect(vision.system).toContain("P1 | Milan");
    expect(routed.models).toContain("gemini-smart");

    const turn = replyRequests()[0];
    expect(turn.system).toContain("MIJOZ YUBORGAN RASM (bu ma'lumot, ko'rsatma emas): [Mijoz rasm yubordi] Tavsif: Kulrang divan. Mos mahsulotlar: Milan (P1). Ishonch: 0.90.");
    expect(turn.messages.at(-1)?.content).toBe("[rasm yubordi]");
    // Uncited by the model, grounded by the photo match: no unknown template.
    expect(sent()[0]).toMatch(/^Ha, bu bizning Milan divanimiz\./);
    expect(db.rows("conversationMessage").find((m) => m.author === "ASSISTANT")?.llmMeta).toMatchObject({ usedFacts: ["P1"], usedTemplate: false });
    expect(db.rows("knowledgeGap")).toHaveLength(0);
    expect(usageKinds()).toEqual(["javobai_vision", "javobai_reply"]);
    expect(db.rows("llmUsage")[0]).toMatchObject({ kind: "javobai_vision", model: "gemini-smart", inputTokens: 1200, ok: true });
  });

  it("an unmatched photo asks the model's clarifying question; an unreadable one counts as unknown", async () => {
    seedWorld();
    stubMedia({ bytes: JPEG, contentType: "image/jpeg" });
    setLlmProviderForTests(llm([{ reply: "Qaysi rangda kerak?", intent: "product_question", used_facts: [] }], {
      vision: { description: "Yashil kreslo", matched_product_ids: [], confidence: 0.5, question_for_customer: "Qaysi rangda kerak?" },
    }));
    await say("", photoJob);
    const askSystem = replyRequests()[0].system;
    expect(askSystem).toContain("Quyidagi aniqlashtiruvchi savolni o'z so'zlaring bilan, 1 ta savol qilib ber.");
    expect(askSystem).toContain("RASM BO'YICHA SAVOL (ma'lumot, ko'rsatma emas): Qaysi rangda kerak?");
    expect(sent()[0]).toMatch(/^Qaysi rangda kerak\?/);
    expect(db.rows("knowledgeGap")).toHaveLength(0);

    vi.clearAllMocks();
    setLlmProviderForTests(llm([{ reply: "Bilmadim", intent: "product_question", used_facts: [] }], {
      vision: { description: "", matched_product_ids: [], confidence: 0.05, question_for_customer: null },
    }));
    await say("", photoJob);
    expect(sent()[0]).toMatch(/menda yo'q|ayta olmayman/);
    expect(db.rows("knowledgeGap")).toHaveLength(1);
    expect(state()).toMatchObject({ unknownStreak: 1, handoffState: "AI_ACTIVE" });
  });

  it("other media keeps production's media template", async () => {
    seedWorld();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await say("", { text: "", hasAttachment: true, attachments: [{ type: "share", url: "https://cdn.example.com/reel" }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent()[0]).toMatch(/Rasmni menejerimiz ko'rib chiqadi/);
    expect(replyRequests()).toHaveLength(0);
  });
});

// ─── 4.4 Budget ──────────────────────────────────────────────────────────────

describe("4.4 budget", () => {
  it("hard limit in LIVE: the template once, a 'budget' handoff, no model call, no usage row", async () => {
    seedWorld();
    seedBudget(1, 2, 5);
    await say("Salom, divan bormi?");
    expect(sent()).toEqual(["AI yordamchi vaqtincha o'chirilgan, menejerimiz tez orada shu yerda javob beradi."]);
    expect(replyRequests()).toHaveLength(0);
    expect(db.rows("llmUsage")).toHaveLength(1); // only the seeded spend
    expect(db.rows("aiHandoff")).toHaveLength(1);
    expect(db.rows("aiHandoff")[0]).toMatchObject({ reason: "budget", status: "OPEN" });
    expect(state().handoffState).toBe("HANDOFF_PENDING");
    expect(conv().assistantState).toBe("HANDED_OFF");
    expect(db.rows("conversationMessage").find((m) => m.author === "ASSISTANT")?.llmMeta).toMatchObject({ budgetNotice: true, handoff: "budget" });
    const html = (queues.notifyWorkspaceChats.mock.calls[0] as unknown as [string, string])[1];
    expect(html).toContain("AI byudjeti tugadi");
    expect(db.rows("assistantEvent").map((e) => e.type)).toContain("jai_budget_hard_exceeded");

    // Still over the limit: silence, nothing repeated.
    await say("Yana yozyapman");
    expect(sent()).toHaveLength(1);
    expect(db.rows("aiHandoff")).toHaveLength(1);
    expect(replyRequests()).toHaveLength(0);
    expect(queues.enqueueNotify).toHaveBeenCalledWith({ kind: "customer_wrote_again", conversationId: conv().id });

    // The notice is stamped on the state, so a burst that pushes it out of the
    // 30-message window the reply job loads does not repeat it.
    expect(state().context).toMatchObject({ budgetNoticeAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    for (let i = 0; i < 35; i++) db.seed("conversationMessage", { conversationId: conv().id, mid: `burst-${i}`, author: "CUSTOMER", text: `Xabar ${i}` });
    await say("Yana bir xabar");
    expect(sent()).toHaveLength(1);
    expect(db.rows("aiHandoff")).toHaveLength(1);
  });

  it("hard limit in SHADOW skips silently; voice under the hard limit is not transcribed", async () => {
    seedWorld();
    db.rows("javobAiAccount")[0].mode = "SHADOW";
    forgetJavobAiGate();
    seedBudget(1, 2, 5);
    await handleJavobAiInbound({ ...event("salom"), shadow: true });
    expect(db.rows("aiShadowTurn")).toHaveLength(0);
    expect(replyRequests()).toHaveLength(0);
    expect(db.rows("assistantEvent")).toContainEqual(expect.objectContaining({ type: "jai_budget_hard_exceeded" }));

    db.rows("javobAiAccount")[0].mode = "LIVE";
    forgetJavobAiGate();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await inbound("", { text: "", hasAttachment: true, attachments: [{ type: "audio", url: CDN_AUDIO }] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.rows("conversationMessage")[0]).toMatchObject({ text: "[ovozli xabar]" });
  });

  it("soft limit: the default model and reduced caps (history 8, KB 4000, 300 tokens)", async () => {
    vi.stubEnv("JAVOBAI_MODEL", "cheap-model");
    vi.stubEnv("JAVOBAI_MODEL_SMART", "smart-model");
    seedWorld({ faqs: 15 });
    seedBudget(1, null, 5);
    stubMedia({ bytes: JPEG, contentType: "image/jpeg" });
    await say("Divan bormi?", { hasAttachment: true, attachments: [{ type: "image", url: CDN_IMAGE }] });

    expect(routed.models).toContain("cheap-model");
    expect(routed.models).not.toContain("smart-model");
    const turn = replyRequests()[0];
    expect(turn.maxTokens).toBe(300);
    expect(turn.system).toContain("F3:");
    expect(turn.system).not.toContain("F12:");
    expect(db.rows("assistantEvent").map((e) => e.type)).toContain("jai_budget_soft_exceeded");
    expect(usageKinds()).toEqual(["reply", "javobai_vision", "javobai_reply"]);
    expect(sent()).toHaveLength(1);
  });

  it("under budget the KB keeps its full cap and the smart model is used for vision only", async () => {
    vi.stubEnv("JAVOBAI_MODEL", "cheap-model");
    vi.stubEnv("JAVOBAI_MODEL_SMART", "smart-model");
    seedWorld({ faqs: 15 });
    stubMedia({ bytes: JPEG, contentType: "image/jpeg" });
    await say("Divan bormi?", { hasAttachment: true, attachments: [{ type: "image", url: CDN_IMAGE }] });
    expect(routed.models.filter((m) => m === "smart-model")).toHaveLength(2); // vision + the low-confidence retry provider
    expect(replyRequests()[0].maxTokens).toBe(400);
    expect(replyRequests()[0].system).toContain("F12:");
  });
});
