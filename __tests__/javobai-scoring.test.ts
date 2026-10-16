/**
 * JavobAI pure pieces: config defaults, scoring, output schema, the
 * knowledge block (ids, product retrieval across scripts, the cap), the
 * business handoff rules and Gemini pricing / the provider factory.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_JAVOBAI_CONFIG, DEFAULT_SCORING, HANDOFF_REASONS, INTENTS, SCORE_SIGNALS, javobAiConfigSchema, readJavobAiConfig } from "../lib/javobai/config";
import { buildKnowledgeBlock, MAX_KB_CHARS, selectKbProducts } from "../lib/javobai/knowledge";
import { parseJavobAiOutput } from "../lib/javobai/schema";
import { bandFor, computeScore, newSignals, readScoringConfig, scoreLabel, signalsFromTurn, temperatureFor } from "../lib/javobai/scoring";
import { matchHandoffRule } from "../lib/javobai/turn";
import { calcCostUsd, getLlmProviderFor, OpenAICompatibleProvider, priceFor, setLlmProviderForTests } from "../lib/assistant/llm/provider";
import type { ProfileSnapshot } from "../lib/assistant/prompt";

afterEach(() => {
  vi.unstubAllEnvs();
  setLlmProviderForTests(undefined);
});

describe("config", () => {
  it("has the contract defaults", () => {
    expect(DEFAULT_JAVOBAI_CONFIG).toEqual({
      confidenceThreshold: 0.55,
      unknownStreakForHandoff: 2,
      qualificationQuestions: ["product", "budget"],
      maxTurns: 12,
      askPhoneAtTemperature: "WARM",
      postHandoffReplies: 0,
      resumeAfterCloseHours: 24,
      isTest: true,
    });
    expect(javobAiConfigSchema.safeParse({ confidenceThreshold: 0.95 }).success).toBe(false);
    expect(javobAiConfigSchema.safeParse({ maxTurns: 3 }).success).toBe(false);
  });

  it("reads stored JSON leniently: valid fields kept, the rest defaulted", () => {
    expect(readJavobAiConfig({ maxTurns: 8, confidenceThreshold: 5, isTest: false })).toMatchObject({ maxTurns: 8, confidenceThreshold: 0.55, isTest: false });
    expect(readJavobAiConfig(null)).toEqual(DEFAULT_JAVOBAI_CONFIG);
  });

  it("exposes the TZ 24 signals, the intents and Uzbek handoff labels", () => {
    expect(SCORE_SIGNALS.map((s) => [s.key, s.defaultPoints])).toEqual([
      ["product_selected", 10], ["price_asked", 15], ["phone_provided", 20], ["purchase_intent", 25], ["payment_intent", 30],
      ["email_provided", 5], ["budget_given", 10], ["location_given", 5], ["returning_contact", 5], ["came_from_ad", 5], ["complaint", -20],
    ]);
    expect(DEFAULT_SCORING.thresholds).toEqual({ warm: 30, hot: 60, veryHot: 80 });
    expect(INTENTS).toContain("purchase_intent");
    expect(INTENTS).toContain("payment_intent");
    expect(INTENTS).toContain("sensitive");
    expect(HANDOFF_REASONS.wants_human).toBe("Mijoz operator so'radi");
  });
});

describe("scoring", () => {
  it("sums, clamps and bands", () => {
    expect(computeScore([{ signal: "a", points: 10 }, { signal: "b", points: 15 }])).toBe(25);
    expect(computeScore([{ signal: "a", points: 90 }, { signal: "b", points: 30 }])).toBe(100);
    expect(computeScore([{ signal: "complaint", points: -20 }])).toBe(0);
    expect(bandFor(0)).toBe("Cold");
    expect(bandFor(30)).toBe("Warm");
    expect(bandFor(60)).toBe("Hot");
    expect(bandFor(80)).toBe("Very hot");
    expect(temperatureFor(85)).toBe("HOT");
    expect(temperatureFor(45)).toBe("WARM");
    expect(scoreLabel(72)).toBe("🔥 HOT 72");
    expect(scoreLabel(85)).toBe("🔥🔥 VERY HOT 85");
    expect(scoreLabel(12)).toBe("❄️ COLD 12");
  });

  it("derives signals from the turn and counts each once per cycle", () => {
    const all = signalsFromTurn({
      intent: "payment_intent",
      extracted: { product: "Milan", budget: "5 mln", email: "a@b.uz" },
      phoneKnown: true,
      returningContact: true,
      cameFromAd: true,
    });
    expect(all.map((s) => s.signal).sort()).toEqual(
      ["budget_given", "came_from_ad", "email_provided", "payment_intent", "phone_provided", "product_selected", "purchase_intent", "returning_contact"]
    );
    expect(all.find((s) => s.signal === "payment_intent")?.points).toBe(30);
    expect(newSignals(all, ["product_selected", "phone_provided"]).map((s) => s.signal)).not.toContain("product_selected");
    expect(signalsFromTurn({ intent: "complaint", extracted: {}, phoneKnown: false, returningContact: false, cameFromAd: false })).toEqual([
      { signal: "complaint", points: -20 },
    ]);
  });

  it("reads a stored scoring config with per-workspace overrides", () => {
    const cfg = readScoringConfig({ rules: [{ signal: "price_asked", points: 40 }], thresholds: { warm: 20 }, handoffAtScore: 70 });
    expect(cfg.rules).toEqual([{ signal: "price_asked", points: 40 }]);
    expect(cfg.thresholds).toEqual({ warm: 20, hot: 60, veryHot: 80 });
    expect(cfg.handoffAtScore).toBe(70);
    expect(readScoringConfig(null).rules).toEqual(DEFAULT_SCORING.rules);
  });
});

describe("output schema", () => {
  it("parses a fenced JSON string, clamps confidence and keeps only KB ids", () => {
    const out = parseJavobAiOutput('```json\n{"reply":"Ha","intent":"price_question","confidence":"1.4","used_facts":["p1"," F2 ","x9"],"extracted":{"name":null,"email":null,"product":"Milan","interest":null,"budget":null,"location":null,"extra_field":null},"language":"uz_latn","handoff_request":{"needed":false,"reason":null},"unknown_question":null,"memory_note":null}\n```');
    expect(out).toMatchObject({ reply: "Ha", intent: "price_question", confidence: 1, used_facts: ["P1", "F2"] });
    expect(out?.extracted.product).toBe("Milan");
  });

  it("defaults unknown intents and missing fields", () => {
    const out = parseJavobAiOutput({ reply: "x", intent: "nonsense" });
    expect(out).toMatchObject({ intent: "other", confidence: 0, used_facts: [], handoff_request: { needed: false, reason: null } });
    expect(parseJavobAiOutput("not json")).toBeNull();
  });
});

const profile = (products: ProfileSnapshot["products"] = []): ProfileSnapshot => ({
  companyName: "Mebel Plus",
  description: "Divan va kreslolar",
  pricePolicy: "EXACT",
  tone: "FRIENDLY",
  personaName: null,
  extraFieldLabel: null,
  address: "Toshkent, Chilonzor",
  delivery: "Toshkent bo'ylab bepul",
  workingHours: null,
  paymentMethods: ["naqd", "click"],
  categories: [],
  faqs: [{ question: "Kafolat bormi?", answer: "1 yil" }],
  products,
  finalMessageTemplate: null,
});

describe("knowledge block", () => {
  it("numbers profile facts, products, FAQs and verified entries", () => {
    const kb = buildKnowledgeBlock(
      profile([{ name: "Milan", note: "3 o'rinli", price: 4_500_000, priceIsFrom: false, currency: "UZS", unit: null }]),
      [{ kind: "DISCOUNT", title: "Oktabr", body: "10% chegirma" }],
      "divan"
    );
    expect(kb.lines.map((l) => l.id)).toEqual(["B1", "B2", "B3", "B4", "B5", "P1", "F1", "K1"]);
    expect(kb.text).toContain("P1: Milan (3 o'rinli) — 4 500 000 so'm");
    expect(kb.text).toContain("K1: Chegirma — Oktabr: 10% chegirma");
    expect(kb.filterContext.knownPrices).toEqual([{ amount: 4_500_000, currency: "UZS" }]);
    expect(kb.truncated).toBe(false);
  });

  it("retrieves products across scripts (Cyrillic query, Latin catalog)", () => {
    const products = Array.from({ length: 30 }, (_, i) => ({
      name: i === 17 ? "Divan Milan" : `Kreslo ${i}`,
      note: null,
      price: null,
      priceIsFrom: false,
      currency: "UZS",
      unit: null,
    }));
    const picked = selectKbProducts(products, "Диван Милан нархи канча?");
    expect(picked[0].name).toBe("Divan Milan");
    expect(picked).toHaveLength(15);
  });

  it("caps the block at MAX_KB_CHARS and reports truncation", () => {
    const faqs = Array.from({ length: 20 }, (_, i) => ({ question: `Savol ${i}`, answer: "x".repeat(400) }));
    const kb = buildKnowledgeBlock({ ...profile(), faqs }, []);
    expect(kb.chars).toBeLessThanOrEqual(MAX_KB_CHARS);
    expect(kb.truncated).toBe(true);
  });
});

describe("handoff rules", () => {
  const now = new Date("2026-10-16T18:30:00+05:00");
  it("matches keyword (normalised), intent, score, unknown count and off-hours", () => {
    expect(matchHandoffRule([{ kind: "KEYWORD", value: { keywords: ["shikoyat"] } }], { text: "Менда ШИКОЯТ бор", intent: "other", score: 0, unknownStreak: 0, now })?.kind).toBe("KEYWORD");
    expect(matchHandoffRule([{ kind: "INTENT", value: { intents: ["payment_intent"] } }], { text: "", intent: "payment_intent", score: 0, unknownStreak: 0, now })?.kind).toBe("INTENT");
    expect(matchHandoffRule([{ kind: "SCORE", value: { min: 50 } }], { text: "", intent: "other", score: 49, unknownStreak: 0, now })).toBeNull();
    expect(matchHandoffRule([{ kind: "UNKNOWN_COUNT", value: { count: 3 } }], { text: "", intent: "other", score: 0, unknownStreak: 3, now })?.kind).toBe("UNKNOWN_COUNT");
    expect(matchHandoffRule([{ kind: "OFF_HOURS", value: { from: "18:00", to: "09:00" } }], { text: "", intent: "other", score: 0, unknownStreak: 0, now })?.kind).toBe("OFF_HOURS");
    expect(matchHandoffRule([{ kind: "OFF_HOURS", value: { from: "20:00", to: "09:00" } }], { text: "", intent: "other", score: 0, unknownStreak: 0, now })).toBeNull();
  });
});

describe("Gemini pricing and the provider factory", () => {
  it("prices Gemini models so JavobAI cost is never $0", () => {
    expect(priceFor("gemini-3.1-flash-lite")).toEqual([0.25, 1.5]);
    expect(priceFor("gemini-2.5-flash")).toEqual([0.3, 2.5]);
    expect(priceFor("gemini-2.5-flash-lite")).toEqual([0.1, 0.4]);
    expect(priceFor("gemini-2.5-pro")).toEqual([1.25, 10]);
    expect(calcCostUsd("gemini-3.1-flash-lite", 1000, 200)).toBeGreaterThan(0);
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual([1, 5]); // unchanged
  });

  it("builds a provider for another model with the same base config", () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("LLM_API_KEY", "k");
    vi.stubEnv("LLM_MODEL", "gemini-3.1-flash-lite");
    vi.stubEnv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai");
    const smart = getLlmProviderFor("gemini-2.5-pro");
    expect(smart).toBeInstanceOf(OpenAICompatibleProvider);
    expect(smart?.model).toBe("gemini-2.5-pro");
    expect(getLlmProviderFor(undefined)?.model).toBe("gemini-3.1-flash-lite");
    expect(smart?.costUsd(1_000_000, 0)).toBe(1.25);
  });
});
