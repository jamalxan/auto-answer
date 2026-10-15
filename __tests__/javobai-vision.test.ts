/**
 * ETAP 4.3 — vision: prompt building (catalog cap), schema parsing, the
 * provider call (image on the last user message, no bytes in the result),
 * decideImageOutcome and the usage helper. The LLM provider is a fake.
 */

import { describe, expect, it, vi } from "vitest";
import type { LLMProvider, LlmRequest } from "../lib/assistant/llm/provider";
import {
  MAX_CATALOG_ITEMS,
  VISION_JSON_SCHEMA,
  VisionError,
  buildVisionPrompt,
  catalogForPrompt,
  decideImageOutcome,
  describeAndMatchImage,
  parseVisionOutput,
  visionOutputSchema,
  visionSystemNote,
  visionUsageRecord,
} from "../lib/javobai/vision";

const catalog = [
  { id: "P1", name: "Divan Milan", note: "3 o'rinli, kulrang" },
  { id: "P2", name: "Kreslo Roma" },
  { id: "P3", name: "Stol Verona", note: null },
];

const image = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 3)]);

function fakeProvider(answer: unknown, opts: { fail?: Error } = {}) {
  const calls: LlmRequest[] = [];
  const provider: LLMProvider = {
    name: "fake",
    model: "gemini-2.5-flash",
    complete: vi.fn(async (request: LlmRequest) => {
      calls.push(request);
      if (opts.fail) throw opts.fail;
      return { json: answer, inputTokens: 1200, outputTokens: 60, model: "gemini-2.5-flash", latencyMs: 800 };
    }),
    costUsd: (i, o) => (i * 0.3 + o * 2.5) / 1_000_000,
  };
  return { provider, calls };
}

describe("buildVisionPrompt", () => {
  it("lists the catalog as id | name — note and caps at 60 items", () => {
    const prompt = buildVisionPrompt({ catalog, lang: "ru", customerText: "Shunaqasi bormi?" });
    expect(prompt.system).toContain("P1 | Divan Milan — 3 o'rinli, kulrang");
    expect(prompt.system).toContain("P2 | Kreslo Roma");
    expect(prompt.system).toContain("P3 | Stol Verona");
    expect(prompt.system).toContain("Russian");
    expect(prompt.user).toContain('Customer wrote: "Shunaqasi bormi?"');
    expect(prompt.truncated).toBe(false);

    const big = Array.from({ length: 80 }, (_, i) => ({ id: `P${i + 1}`, name: `Item ${i + 1}` }));
    const capped = catalogForPrompt(big);
    expect(capped.lines).toHaveLength(MAX_CATALOG_ITEMS);
    expect(capped.truncated).toBe(true);
    expect(buildVisionPrompt({ catalog: big }).system).not.toContain("P61 |");
  });

  it("handles an empty catalog and strips newlines from names", () => {
    const prompt = buildVisionPrompt({ catalog: [] });
    expect(prompt.system).toContain("Catalog: (empty");
    expect(prompt.user).toContain("no text");
    const lines = catalogForPrompt([{ id: "P9", name: "Line\none\r\ntwo", note: "a\nb" }]).lines;
    expect(lines[0]).toBe("P9 | Line one two — a b");
  });
});

describe("parseVisionOutput / schema", () => {
  it("parses an object, a JSON string and fenced JSON; keeps only known ids", () => {
    const raw = { description: "Kulrang divan", matched_product_ids: ["P1", "P1", "P77", 42], confidence: 0.8, question_for_customer: null };
    expect(parseVisionOutput(raw, catalog)).toEqual({
      description: "Kulrang divan",
      matched_product_ids: ["P1"],
      confidence: 0.8,
      question_for_customer: null,
    });
    expect(parseVisionOutput(JSON.stringify(raw), catalog)?.matched_product_ids).toEqual(["P1"]);
    expect(parseVisionOutput("```json\n" + JSON.stringify(raw) + "\n```", catalog)?.description).toBe("Kulrang divan");
  });

  it("is forgiving about missing and odd fields", () => {
    expect(parseVisionOutput({}, catalog)).toEqual({ description: "", matched_product_ids: [], confidence: 0, question_for_customer: null });
    expect(parseVisionOutput({ confidence: "0.75", question_for_customer: "  Qaysi rang?  " }, catalog)).toMatchObject({
      confidence: 0.75,
      question_for_customer: "Qaysi rang?",
    });
    expect(parseVisionOutput({ confidence: 7 }, catalog)?.confidence).toBe(1);
    expect(visionOutputSchema.parse({ description: "x".repeat(2000) }).description).toHaveLength(600);
  });

  it("returns null for unparseable output", () => {
    expect(parseVisionOutput("not json at all", catalog)).toBeNull();
    expect(parseVisionOutput(null, catalog)).toBeNull();
    expect(parseVisionOutput(42, catalog)).toBeNull();
  });

  it("declares the four fields in the JSON schema", () => {
    expect(VISION_JSON_SCHEMA.required).toEqual(["description", "matched_product_ids", "confidence", "question_for_customer"]);
  });
});

describe("describeAndMatchImage", () => {
  it("sends the image as base64 on the user message and maps matches to names", async () => {
    const { provider, calls } = fakeProvider({
      description: "Kulrang uch o'rinli divan",
      matched_product_ids: ["P1"],
      confidence: 0.85,
      question_for_customer: null,
    });
    const result = await describeAndMatchImage({ buffer: image, mime: "image/jpeg", catalog, provider, lang: "uz_latn" });

    expect(result).toMatchObject({
      description: "Kulrang uch o'rinli divan",
      matches: [{ id: "P1", name: "Divan Milan" }],
      confidence: 0.85,
      question: null,
      model: "gemini-2.5-flash",
      inputTokens: 1200,
      outputTokens: 60,
      latencyMs: 800,
      catalogTruncated: false,
    });
    expect(result.costUsd).toBeCloseTo((1200 * 0.3 + 60 * 2.5) / 1_000_000, 9);

    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.images).toEqual([{ mediaType: "image/jpeg", base64: image.toString("base64") }]);
    expect(request.messages.at(-1)?.role).toBe("user");
    expect(request.schemaName).toBe("javobai_vision");
    expect(request.schema).toBe(VISION_JSON_SCHEMA);
    expect(request.system).toContain("P1 | Divan Milan");
    // No bytes leak into the result object.
    expect(JSON.stringify(result)).not.toContain(image.toString("base64"));
  });

  it("throws unparseable when the model ignores the schema", async () => {
    const { provider } = fakeProvider("I cannot see the image.");
    await expect(describeAndMatchImage({ buffer: image, mime: "image/jpeg", catalog, provider })).rejects.toMatchObject({
      code: "unparseable",
    });
  });

  it("wraps provider errors without the request", async () => {
    const { provider } = fakeProvider(null, { fail: new Error("OpenAI 503: overloaded " + image.toString("base64")) });
    const error = await describeAndMatchImage({ buffer: image, mime: "image/jpeg", catalog, provider }).catch((e) => e);
    expect(error).toBeInstanceOf(VisionError);
    expect(error.code).toBe("llm");
    expect(error.message.length).toBeLessThan(320);
  });

  it("requires a provider", async () => {
    await expect(
      describeAndMatchImage({ buffer: image, mime: "image/jpeg", catalog, provider: null as unknown as LLMProvider })
    ).rejects.toMatchObject({ code: "no_provider" });
  });
});

describe("decideImageOutcome", () => {
  const match = [{ id: "P1", name: "Divan Milan" }];

  it("answers from the catalog on a confident match", () => {
    expect(decideImageOutcome({ matches: match, confidence: 0.6 })).toBe("answer_from_catalog");
    expect(decideImageOutcome({ matches: match, confidence: 0.95 })).toBe("answer_from_catalog");
    expect(decideImageOutcome({ matches: match, confidence: 0.5 }, 0.5)).toBe("answer_from_catalog");
  });

  it("asks on a weak match, a question, or a readable description", () => {
    expect(decideImageOutcome({ matches: match, confidence: 0.4 })).toBe("ask");
    expect(decideImageOutcome({ matches: [], confidence: 0.3, question: "Qaysi rang?" })).toBe("ask");
    expect(decideImageOutcome({ matches: [], confidence: 0.7, description: "Qizil kreslo" })).toBe("ask");
  });

  it("hands off when the picture was not understood", () => {
    expect(decideImageOutcome({ matches: [], confidence: 0 })).toBe("handoff");
    expect(decideImageOutcome({ matches: [], confidence: 0.1, description: "blurry" })).toBe("handoff");
    expect(decideImageOutcome({ matches: [], confidence: 0.9, description: "" })).toBe("handoff");
  });

  it("is pure about odd confidence values", () => {
    expect(decideImageOutcome({ matches: match, confidence: Number.NaN })).toBe("ask");
    expect(decideImageOutcome({ matches: match, confidence: 5 })).toBe("answer_from_catalog");
  });
});

describe("usage row and system note", () => {
  it("builds the LlmUsage row with kind javobai_vision", () => {
    expect(
      visionUsageRecord(
        { model: "gemini-2.5-flash", inputTokens: 1200, outputTokens: 60, costUsd: 0.00051, latencyMs: 800 },
        { workspaceId: "ws1", conversationId: "c1" }
      )
    ).toEqual({
      workspaceId: "ws1",
      conversationId: "c1",
      kind: "javobai_vision",
      model: "gemini-2.5-flash",
      inputTokens: 1200,
      outputTokens: 60,
      costUsd: 0.00051,
      latencyMs: 800,
      ok: true,
    });
  });

  it("writes a one-line note with matches or none", () => {
    expect(visionSystemNote({ description: "Kulrang divan", matches: [{ id: "P1", name: "Divan Milan" }], confidence: 0.85 })).toBe(
      "[Mijoz rasm yubordi] Tavsif: Kulrang divan. Mos mahsulotlar: Divan Milan (P1). Ishonch: 0.85."
    );
    expect(visionSystemNote({ description: "", matches: [], confidence: 0 })).toContain("topilmadi");
  });
});
