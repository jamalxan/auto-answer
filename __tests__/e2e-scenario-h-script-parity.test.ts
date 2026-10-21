/**
 * Scenario H: script parity. The same ten customer questions written in Uzbek
 * Latin, Uzbek Cyrillic and Russian must produce the same intent / signal
 * through the deterministic layers (no model involved):
 *
 *   - lib/javobai/price-detector.ts      (PRICE_ASKED)
 *   - lib/triggers/keywords.ts           (built-in intent dictionary + keyword normaliser)
 *   - lib/javobai/language.ts            (language / script)
 *   - lib/leads/phone.ts                 (phone extraction)
 *   - runJavobAiTurn with a mocked model (the model always answers OTHER)
 *
 * Intents the code has no deterministic detector for (opening hours, human
 * request, thanks, complaint) are covered for what IS deterministic: no layer
 * may fire a false price / intent hit on them, in any script, and the language
 * detector must classify each script correctly.
 */

import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../lib/assistant/llm/provider";
import type { ProfileSnapshot } from "../lib/assistant/prompt";
import { DEFAULT_JAVOBAI_CONFIG } from "../lib/javobai/config";
import { buildKnowledgeBlock } from "../lib/javobai/knowledge";
import { detectLanguageV2, type LangV2 } from "../lib/javobai/language";
import { detectsPriceQuestion } from "../lib/javobai/price-detector";
import { DEFAULT_SCORING_CONFIG } from "../lib/javobai/scoring";
import { runJavobAiTurn, type JavobAiTurnContext } from "../lib/javobai/turn";
import { extractPhone } from "../lib/leads/phone";
import { BUILT_IN_INTENTS, findIntent, findKeyword, normalizeForMatch } from "../lib/triggers/keywords";

type ScriptKey = "uz-latn" | "uz-cyrl" | "ru";
const SCRIPTS: ScriptKey[] = ["uz-latn", "uz-cyrl", "ru"];

interface Question {
  name: string;
  /** Built-in intent the dictionary must report (null: the code has no detector, nothing may fire). */
  intent: string | null;
  price: boolean;
  text: Record<ScriptKey, string>;
}

const QUESTIONS: Question[] = [
  { name: "price", intent: "PRICE", price: true, text: { "uz-latn": "Salom, narxi qancha?", "uz-cyrl": "Салом, нархи қанча?", ru: "Здравствуйте, сколько стоит?" } },
  { name: "delivery", intent: "DELIVERY", price: false, text: { "uz-latn": "Yetkazib berasizmi?", "uz-cyrl": "Етказиб берасизми?", ru: "Есть доставка?" } },
  { name: "location", intent: "ADDRESS", price: false, text: { "uz-latn": "Manzilingiz qayerda?", "uz-cyrl": "Манзилингиз қаерда?", ru: "Где вы находитесь?" } },
  { name: "working hours", intent: null, price: false, text: { "uz-latn": "Ish vaqtingiz qanday?", "uz-cyrl": "Иш вақтингиз қандай?", ru: "Во сколько вы работаете?" } },
  { name: "phone request", intent: "CONTACT", price: false, text: { "uz-latn": "Telefon raqamingiz qanday?", "uz-cyrl": "Телефон рақамингиз қандай?", ru: "Дайте ваш телефон" } },
  { name: "human request", intent: null, price: false, text: { "uz-latn": "Menejer bilan gaplashmoqchiman", "uz-cyrl": "Менежер билан гаплашмоқчиман", ru: "Хочу поговорить с менеджером" } },
  { name: "thanks", intent: null, price: false, text: { "uz-latn": "Rahmat katta", "uz-cyrl": "Раҳмат катта", ru: "Спасибо большое" } },
  { name: "complaint", intent: null, price: false, text: { "uz-latn": "Shikoyatim bor, divan buzuq keldi", "uz-cyrl": "Шикоятим бор, диван бузуқ келди", ru: "У меня жалоба, диван пришёл сломанный" } },
  { name: "order intent", intent: "ORDER", price: false, text: { "uz-latn": "Buyurtma bermoqchiman", "uz-cyrl": "Буюртма бермоқчиман", ru: "Хочу заказать" } },
  { name: "generic FAQ", intent: "INFO", price: false, text: { "uz-latn": "Batafsil ma'lumot bering", "uz-cyrl": "Батафсил маълумот беринг", ru: "Подробнее, пожалуйста" } },
];

const ALL_INTENT_KEYS = BUILT_IN_INTENTS.map((i) => i.key);

describe("Scenario H: price detector parity", () => {
  it.each(QUESTIONS)("$name: same PRICE_ASKED verdict in all three scripts", (q) => {
    for (const script of SCRIPTS) expect(detectsPriceQuestion(q.text[script]), `${script}: ${q.text[script]}`).toBe(q.price);
  });
});

describe("Scenario H: built-in intent dictionary parity", () => {
  it.each(QUESTIONS)("$name: same intent in all three scripts", (q) => {
    for (const script of SCRIPTS) {
      const hit = findIntent(q.text[script], ALL_INTENT_KEYS);
      expect(hit?.intent ?? null, `${script}: ${q.text[script]}`).toBe(q.intent);
    }
  });

  it("every built-in intent carries Latin, Cyrillic and Russian-letter variants that agree with each other", () => {
    for (const intent of BUILT_IN_INTENTS) {
      const hasLatin = intent.examples.some((e) => /^[a-z' ]+$/i.test(e));
      const hasCyrillic = intent.examples.some((e) => /\p{Script=Cyrillic}/u.test(e));
      expect(hasLatin && hasCyrillic, intent.key).toBe(true);
    }
  });

  it("the price dictionary and the price detector agree on the PRICE question in every script", () => {
    const price = QUESTIONS[0];
    for (const script of SCRIPTS) {
      expect(findIntent(price.text[script], ["PRICE"])?.intent).toBe("PRICE");
      expect(detectsPriceQuestion(price.text[script])).toBe(true);
    }
  });
});

describe("Scenario H: keyword normaliser parity (merchant types a keyword once)", () => {
  it("'operator' matches the Latin, Cyrillic and Russian spellings", () => {
    for (const text of ["Operator kerak", "Оператор керак", "Мне нужен оператор"]) {
      expect(findKeyword(text, ["operator"], "CONTAINS"), text).toBe("operator");
    }
  });

  it("'menejer' matches the Uzbek Latin and Uzbek Cyrillic spellings", () => {
    expect(findKeyword("Menejer kerak", ["menejer"], "CONTAINS")).toBe("menejer");
    expect(findKeyword("Менежер керак", ["menejer"], "CONTAINS")).toBe("menejer");
  });

  it("'menejer' also matches the Russian spelling 'менеджер' (same word, third script)", () => {
    expect(normalizeForMatch("менеджер")).toBe(normalizeForMatch("menejer"));
    expect(findKeyword("Нужен менеджер", ["menejer"], "CONTAINS")).toBe("menejer");
  });

  it("'narx' is a whole-word keyword in every script (no suffix matching)", () => {
    for (const text of ["Narxi qancha", "Нархи қанча"]) expect(findKeyword(text, ["narx"], "CONTAINS"), text).toBeNull();
    // whole words only: 'narx' never matches inside 'narxi'; the merchant lists both forms or uses the PRICE intent
    for (const text of ["Narx qancha", "Нарх қанча", "Нарх какой"]) expect(findKeyword(text, ["narx"], "CONTAINS"), text).toBe("narx");
  });
});

describe("Scenario H: language / script detection", () => {
  const EXPECTED: Record<ScriptKey, LangV2> = { "uz-latn": "uz-latn", "uz-cyrl": "uz-cyrl", ru: "ru" };

  it.each(QUESTIONS)("$name: each script is classified as itself", (q) => {
    for (const script of SCRIPTS) expect(detectLanguageV2(q.text[script]), `${script}: ${q.text[script]}`).toBe(EXPECTED[script]);
  });

  it("Uzbek Cyrillic typed without the special letters is still Uzbek, not Russian", () => {
    for (const text of ["Нархи канча?", "Курс качон бошланади?", "Етказиб берасизми?", "Манзилингиз каерда?"]) {
      expect(detectLanguageV2(text), text).toBe("uz-cyrl");
    }
  });
});

describe("Scenario H: phone extraction parity", () => {
  it("the same number is normalised to +998 whatever script the sentence is in", () => {
    const sentences = ["Raqamim 90 123 45 67", "Рақамим 90 123 45 67", "Мой номер 90 123 45 67", "Мой номер +998 (90) 123-45-67", "Raqamim 998901234567"];
    for (const s of sentences) expect(extractPhone(s)?.e164, s).toBe("+998901234567");
  });
});

// ─── The whole turn with a model that always says OTHER ──────────────────────

const profile: ProfileSnapshot = {
  companyName: "Mebel Plus",
  description: "Divan va kreslolar",
  pricePolicy: "EXACT",
  tone: "FRIENDLY",
  personaName: null,
  extraFieldLabel: null,
  address: null,
  delivery: "Toshkent bo'ylab bepul",
  workingHours: null,
  paymentMethods: [],
  categories: [],
  faqs: [],
  products: [{ name: "Milan", note: null, price: 4_500_000, priceIsFrom: false, currency: "UZS", unit: null }],
  finalMessageTemplate: null,
};

function otherModel(): LLMProvider {
  return {
    name: "fake",
    model: "gemini-3.1-flash-lite",
    costUsd: () => 0,
    complete: vi.fn(async () => ({
      json: {
        reply: "Tushundim.",
        intent: "other",
        confidence: 0.9,
        used_facts: [],
        extracted: { name: null, email: null, product: null, interest: null, budget: null, location: null, extra_field: null },
        language: "uz_latn",
        handoff_request: { needed: false, reason: null },
        unknown_question: null,
        memory_note: null,
      },
      inputTokens: 10,
      outputTokens: 10,
      model: "gemini-3.1-flash-lite",
      latencyMs: 1,
    })),
  };
}

function turnCtx(text: string): JavobAiTurnContext {
  return {
    kb: buildKnowledgeBlock(profile, [], text),
    config: { ...DEFAULT_JAVOBAI_CONFIG },
    scoring: DEFAULT_SCORING_CONFIG,
    rules: [],
    state: { handoffState: "AI_ACTIVE", score: 0, extracted: {}, unknownStreak: 0, turns: 1, countedSignals: [], phoneAskCount: 0, askedFields: [], postHandoffReplies: 0 },
    collected: {},
    memory: { summary: "", facts: {}, returning: false },
    context: {},
    history: [],
    customerText: text,
    hasMedia: false,
    igName: null,
    lastBotMessage: null,
    templateOnly: false,
    now: new Date("2026-10-16T12:00:00+05:00"),
    llm: otherModel(),
  };
}

describe("Scenario H: full turn, model says OTHER", () => {
  const LEGACY: Record<ScriptKey, string> = { "uz-latn": "uz_latn", "uz-cyrl": "uz_cyrl", ru: "ru" };

  it.each(QUESTIONS)("$name: same signals and intent in every script, reply in the customer's script", async (q) => {
    const results = [];
    for (const script of SCRIPTS) results.push({ script, result: await runJavobAiTurn(turnCtx(q.text[script])) });
    for (const { script, result } of results) {
      const hasPrice = result.signals.some((s) => s.signal === "price_asked");
      expect(hasPrice, `${script}: ${q.text[script]}`).toBe(q.price);
      expect(result.intent === "price_question", script).toBe(q.price);
      expect(result.language, script).toBe(LEGACY[script]);
      expect(result.handoff.needed, script).toBe(results[0].result.handoff.needed);
    }
    // identical signal sets across the three scripts
    const sets = results.map((r) => r.result.signals.map((s) => s.signal).sort().join(","));
    expect(new Set(sets).size, sets.join(" | ")).toBe(1);
  });
});
