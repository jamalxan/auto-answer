/**
 * ETAP 13 Faza 2 — AI caption (FR-AI1): robust parsing of the model output,
 * caption limits, hashtag normalisation, one repair round, budget refusal,
 * hourly cap, usage accounting. The LLM is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import { LlmError, type LLMProvider, type LlmRequest, setLlmProviderForTests } from "@/lib/assistant/llm/provider";
import { isToolingLlmKind } from "@/lib/assistant/llm/stats";
import { appendHashtags } from "@/components/content/ai-caption-panel";
import { BUDGET_MESSAGE, CAPTION_PER_HOUR, generateCaptions, normalizeHashtags, parseCaptionOutput } from "@/lib/content/ai-caption";

const WS = "w1";

function provider(replies: Array<unknown | Error>): LLMProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const queue = [...replies];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    costUsd: () => 0.002,
    async complete(request: LlmRequest) {
      calls.push(request);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { json: next, inputTokens: 120, outputTokens: 240, model: "fake-model", latencyMs: 7 };
    },
  };
}

const usage = () => db.rows("llmUsage").filter((r) => r.kind === "javobai_caption");
const good = { variants: ["Birinchi variant", "Ikkinchi variant", "Uchinchi variant"], hashtags: ["#mebel", "toshkent", "Mebel"] };

beforeEach(() => {
  resetDb();
  setLlmProviderForTests(undefined);
  db.seed("workspace", { id: WS, ownerId: "u1", name: "Mebel" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("parseCaptionOutput", () => {
  it("accepts an object, a JSON string, a fenced block and JSON embedded in prose", () => {
    expect(parseCaptionOutput(good)?.variants).toHaveLength(3);
    expect(parseCaptionOutput(JSON.stringify(good))?.variants).toHaveLength(3);
    expect(parseCaptionOutput("```json\n" + JSON.stringify(good) + "\n```")?.variants).toHaveLength(3);
    expect(parseCaptionOutput(`Mana: ${JSON.stringify(good)} tamom`)?.variants).toHaveLength(3);
  });

  it("accepts {caption} objects and alternative keys, drops empties and duplicates, keeps at most 3", () => {
    const out = parseCaptionOutput({ captions: [{ caption: "A" }, { text: "B" }, "a", "", "C", "D"], tags: "mebel, divan" });
    expect(out).toEqual({ variants: ["A", "B", "C"], hashtags: ["mebel", "divan"] });
  });

  it("returns null for garbage and for no usable variant", () => {
    expect(parseCaptionOutput("not json")).toBeNull();
    expect(parseCaptionOutput({ variants: [] })).toBeNull();
    expect(parseCaptionOutput(null)).toBeNull();
  });

  it("respects caption limits: long text is cut at 2200 code points, a variant over 30 # is dropped", () => {
    const long = "ё".repeat(2500);
    const tagSpam = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    const out = parseCaptionOutput({ variants: [long, tagSpam, "ok"], hashtags: [] })!;
    expect(Array.from(out.variants[0]).length).toBe(2200);
    expect(out.variants).toHaveLength(2);
    expect(out.variants[1]).toBe("ok");
  });

  it("hashtags: # stripped, spaces / punctuation removed, unique case-insensitively, numbers-only dropped, at most 15", () => {
    expect(normalizeHashtags(["#Mebel", "mebel", "#divan!", "123", "toshkent mebel", "#мебель"])).toEqual(["Mebel", "divan", "toshkent", "мебель"]);
    expect(normalizeHashtags(Array.from({ length: 40 }, (_, i) => `tag${i}`))).toHaveLength(15);
  });
});

describe("appendHashtags (composer)", () => {
  it("appends on a new paragraph and skips tags the caption already has", () => {
    expect(appendHashtags("Salom #Mebel", ["mebel", "divan"])).toBe("Salom #Mebel\n\n#divan");
    expect(appendHashtags("", ["a"])).toBe("#a");
    expect(appendHashtags("x #a", ["A"])).toBe("x #a");
  });
});

describe("generateCaptions", () => {
  it("returns 3 variants + hashtags, records ONE usage row with tokens and cost, kind counted as tooling", async () => {
    const p = provider([good]);
    setLlmProviderForTests(p);
    const out = await generateCaptions(WS, { topic: "Yangi divan kolleksiyasi", tone: "sales", language: "uz", postType: "CAROUSEL" });
    expect(out.variants).toEqual(good.variants);
    expect(out.hashtags).toEqual(["mebel", "toshkent"]);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].system).toMatch(/Uzbek/);
    expect(p.calls[0].system).toMatch(/call to action/);
    expect(p.calls[0].messages[0].content).toMatch(/Yangi divan/);
    expect(usage()).toHaveLength(1);
    expect(usage()[0]).toMatchObject({ workspaceId: WS, ok: true, inputTokens: 120, outputTokens: 240 });
    expect(isToolingLlmKind("javobai_caption")).toBe(true);
  });

  it("passes the existing caption and the language", async () => {
    const p = provider([good]);
    setLlmProviderForTests(p);
    await generateCaptions(WS, { topic: "Chegirma", language: "ru", existingCaption: "Eski matn" });
    expect(p.calls[0].system).toMatch(/Russian/);
    expect(p.calls[0].messages[0].content).toMatch(/Eski matn/);
  });

  it("one repair round on an unusable answer; still one usage row with both calls' tokens", async () => {
    const p = provider(["I cannot", good]);
    setLlmProviderForTests(p);
    const out = await generateCaptions(WS, { topic: "Yangi divan" });
    expect(out.variants).toHaveLength(3);
    expect(p.calls).toHaveLength(2);
    expect(usage()).toHaveLength(1);
    expect(usage()[0].inputTokens).toBe(240);
  });

  it("two unusable answers → 422, usage still recorded", async () => {
    setLlmProviderForTests(provider(["x", "y"]));
    await expect(generateCaptions(WS, { topic: "Yangi divan" })).rejects.toMatchObject({ status: 422 });
    expect(usage()).toHaveLength(1);
  });

  it("refuses when the hard monthly AI budget is spent — the model is never called", async () => {
    db.seed("aiBudget", { workspaceId: WS, monthlyUsdSoft: 1, monthlyUsdHard: 2, periodStart: new Date(), alerted50At: null, alerted80At: null, alerted100At: null });
    db.seed("llmUsage", { workspaceId: WS, kind: "javobai_reply", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 5, latencyMs: 1, ok: true, createdAt: new Date() });
    const p = provider([good]);
    setLlmProviderForTests(p);
    await expect(generateCaptions(WS, { topic: "Yangi divan" })).rejects.toMatchObject({ status: 429, message: BUDGET_MESSAGE });
    expect(p.calls).toHaveLength(0);
    expect(usage()).toHaveLength(0);
  });

  it("hourly cap counted from the usage rows", async () => {
    for (let i = 0; i < CAPTION_PER_HOUR; i++) db.seed("llmUsage", { workspaceId: WS, kind: "javobai_caption", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, ok: true, createdAt: new Date(Date.now() - 60_000) });
    setLlmProviderForTests(provider([good]));
    await expect(generateCaptions(WS, { topic: "Yangi divan" })).rejects.toMatchObject({ status: 429 });
  });

  it("no LLM configured → 503; provider failure → 502 with an explained message and ok=false usage", async () => {
    setLlmProviderForTests(null);
    await expect(generateCaptions(WS, { topic: "Yangi divan" })).rejects.toMatchObject({ status: 503 });
    setLlmProviderForTests(provider([new LlmError("slow", undefined, "timeout")]));
    await expect(generateCaptions(WS, { topic: "Yangi divan" })).rejects.toMatchObject({ status: 502 });
    expect(usage()[0].ok).toBe(false);
  });

  it("validates input: short topic, unknown language, story", async () => {
    setLlmProviderForTests(provider([good]));
    await expect(generateCaptions(WS, { topic: "ab" })).rejects.toMatchObject({ status: 400 });
    await expect(generateCaptions(WS, { topic: "Yangi divan", language: "de" as never })).rejects.toMatchObject({ status: 400 });
    await expect(generateCaptions(WS, { topic: "Yangi divan", postType: "STORY" })).rejects.toMatchObject({ status: 400 });
  });
});
