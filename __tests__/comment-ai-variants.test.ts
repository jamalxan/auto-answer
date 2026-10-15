/**
 * AI reply generator (TZ 10): prompt rules, robust parsing of model output,
 * and the "drafts only" contract with a mocked provider.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider, LlmRequest } from "@/lib/assistant/llm/provider";
import { setLlmProviderForTests } from "@/lib/assistant/llm/provider";
import {
  aiVariantRequestSchema,
  AiVariantsError,
  buildVariantPrompt,
  generateVariantDrafts,
  parseVariantDrafts,
  stripCodeFences,
} from "@/lib/triggers/ai-variants";

const request = aiVariantRequestSchema.parse({
  kind: "DM",
  count: 3,
  goal: "Narx so'raganlarga katalogni yuborish",
  brandName: "Gulnoza Textile",
  keywordsContext: "narx, цена",
});

function fakeProvider(json: unknown): LLMProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    costUsd: () => 0,
    complete: vi.fn(async (req: LlmRequest) => {
      calls.push(req);
      return { json, inputTokens: 1, outputTokens: 1, model: "fake-model", latencyMs: 1 };
    }),
  };
}

afterEach(() => setLlmProviderForTests(undefined));

describe("aiVariantRequestSchema", () => {
  it("bounds the count to 3..10 and needs a goal", () => {
    expect(aiVariantRequestSchema.safeParse({ ...request, count: 2 }).success).toBe(false);
    expect(aiVariantRequestSchema.safeParse({ ...request, count: 11 }).success).toBe(false);
    expect(aiVariantRequestSchema.safeParse({ ...request, goal: " " }).success).toBe(false);
    expect(request).toMatchObject({ tone: "friendly", emojiLevel: "low", language: "uz-latn" });
  });
});

describe("buildVariantPrompt", () => {
  it("forbids invented facts and asks for the exact count and limits", () => {
    const { system, user } = buildVariantPrompt(request);
    expect(system).toMatch(/O'YLAB TOPMA/);
    expect(system).toMatch(/Narx, chegirma/);
    expect(system).toMatch(/Aynan 3 ta/);
    expect(system).toMatch(/1000 belgidan/);
    expect(system).toMatch(/lotin yozuvida/);
    expect(user).toContain("<brend>\nGulnoza Textile\n</brend>");
    expect(user).toContain("narx, цена");
    expect(user).toMatch(/Berilmagan — hech qanday aniq fakt/);
  });

  it("passes given facts through and switches language, tone and public mode", () => {
    const { system, user } = buildVariantPrompt(
      aiVariantRequestSchema.parse({
        ...request,
        kind: "PUBLIC",
        language: "ru",
        tone: "professional",
        emojiLevel: "none",
        facts: "Yetkazib berish bepul",
      })
    );
    expect(system).toMatch(/OCHIQ javob/);
    expect(system).toMatch(/300 belgidan/);
    expect(system).toMatch(/rus tilida/);
    expect(system).toMatch(/rasmiy/);
    expect(system).toMatch(/Emoji ishlatma/);
    expect(system).toMatch(/Ochiq javobda narx/);
    expect(user).toContain("Yetkazib berish bepul");
  });
});

describe("parseVariantDrafts", () => {
  const opts = { kind: "DM" as const, count: 5 };

  it("reads the structured object", () => {
    expect(parseVariantDrafts({ variants: ["Salom!", "Assalomu alaykum!"] }, opts)).toEqual(["Salom!", "Assalomu alaykum!"]);
  });

  it("reads a fenced JSON string, a bare array and {text} items", () => {
    expect(parseVariantDrafts('```json\n{"variants": ["A", "B"]}\n```', opts)).toEqual(["A", "B"]);
    expect(parseVariantDrafts('["A", "B"]', opts)).toEqual(["A", "B"]);
    expect(parseVariantDrafts({ variants: [{ text: "A" }, { text: "B" }, 42, null] }, opts)).toEqual(["A", "B"]);
  });

  it("falls back to one variant per line for plain text", () => {
    expect(parseVariantDrafts("1. Salom!\n2) Xush kelibsiz\n- Rahmat", opts)).toEqual(["Salom!", "Xush kelibsiz", "Rahmat"]);
  });

  it("trims, strips quotes, drops empties and duplicates", () => {
    expect(
      parseVariantDrafts({ variants: ["  “Salom!”  ", "", "   ", "salom", "Salom!!", "Boshqa"] }, opts)
    ).toEqual(["Salom!", "Boshqa"]);
  });

  it("drops over-length texts instead of cutting them, and caps the count", () => {
    const long = "x".repeat(301);
    expect(parseVariantDrafts({ variants: [long, "Qisqa"] }, { kind: "PUBLIC", count: 3 })).toEqual(["Qisqa"]);
    expect(parseVariantDrafts({ variants: [long] }, { kind: "DM", count: 3 })).toEqual([long]);
    expect(parseVariantDrafts({ variants: ["A", "B", "C", "D"] }, { kind: "DM", count: 3 })).toEqual(["A", "B", "C"]);
  });

  it("returns nothing for unusable output", () => {
    expect(parseVariantDrafts(null, opts)).toEqual([]);
    expect(parseVariantDrafts({ reply: "hi" }, opts)).toEqual([]);
    expect(parseVariantDrafts({ variants: "A" }, opts)).toEqual([]);
  });

  it("strips code fences", () => {
    expect(stripCodeFences("```\n[1]\n```")).toBe("[1]");
    expect(stripCodeFences(" plain ")).toBe("plain");
  });
});

describe("generateVariantDrafts", () => {
  it("explains what to do when no LLM is configured", async () => {
    setLlmProviderForTests(null);
    const error = await generateVariantDrafts(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiVariantsError);
    expect((error as AiVariantsError).code).toBe("no_llm");
    expect((error as AiVariantsError).message).toMatch(/qo'lda yozing/);
  });

  it("returns cleaned drafts and sends the prompt with a schema", async () => {
    const provider = fakeProvider({ variants: ["Salom! Katalogni yuboraman", "Salom! Katalogni yuboraman", "Albatta 😊"] });
    setLlmProviderForTests(provider);
    const result = await generateVariantDrafts(request);
    expect(result).toEqual({ drafts: ["Salom! Katalogni yuboraman", "Albatta 😊"], model: "fake-model" });
    expect(provider.calls[0].schemaName).toBe("reply_variants");
    expect(provider.calls[0].system).toMatch(/O'YLAB TOPMA/);
    expect(provider.calls[0].messages[0].content).toContain("<maqsad>");
  });

  it("reports unusable output and provider failures in Uzbek", async () => {
    setLlmProviderForTests(fakeProvider({ nothing: true }));
    await expect(generateVariantDrafts(request)).rejects.toMatchObject({ code: "unusable" });

    const failing = fakeProvider(null);
    failing.complete = vi.fn(async () => {
      throw new Error("Anthropic 529");
    });
    setLlmProviderForTests(failing);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(generateVariantDrafts(request)).rejects.toMatchObject({ code: "llm_failed" });
  });
});
