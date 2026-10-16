/**
 * Shared LLM adapter (B-01 / B-29): Gemini schema sanitising, retries per
 * failure class (400 degraded once, 429 / 5xx / timeout backoff), typed Uzbek
 * errors, metadata-only logging, one outcome counter (rates, p95).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeSchemaForGemini } from "../lib/assistant/llm/gemini-schema";
import { LlmError, OpenAICompatibleProvider, describeLlmFailure } from "../lib/assistant/llm/provider";
import { isLlmErrorRateHigh, percentile, summarizeLlmRows } from "../lib/assistant/llm/stats";
import { FLOW_BUILDER_JSON_SCHEMA } from "../lib/flows/ai-builder-prompt";
import { buildAiCheck } from "../lib/foundation/diagnostics";

const ok = { choices: [{ message: { content: '{"reply":"Salom"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const provider = (fallbacks: string[] = []) => new OpenAICompatibleProvider("secret-key", "gemini-3.1-flash-lite", GEMINI, fallbacks);
const simpleSchema = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] };
const request = { system: "SECRET SYSTEM PROMPT", messages: [{ role: "user" as const, content: "narxi qancha?" }], schema: simpleSchema, schemaName: "x" };

function respond(statuses: number[]) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? JSON.stringify(ok) : '{"error":{"message":"bad"}}', { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const bodyOf = (mock: ReturnType<typeof respond>, i: number) => JSON.parse(mock.mock.calls[i][1].body as string);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Gemini schema sanitiser", () => {
  it("removes keywords Gemini rejects from the Flow Builder schema", () => {
    const { schema, lossy } = sanitizeSchemaForGemini(FLOW_BUILDER_JSON_SCHEMA);
    const text = JSON.stringify(schema);
    expect(text).not.toContain("additionalProperties");
    expect(text).not.toContain("pattern");
    expect(text).not.toContain("maxItems");
    expect(text).not.toContain('"enum":[1]');
    // The nodes are free-form: the schema would strip their fields, so it is flagged lossy.
    expect(lossy).toBe(true);
  });

  it("turns nullable type arrays into nullable and keeps a clean schema intact", () => {
    const { schema, lossy } = sanitizeSchemaForGemini({
      type: "object",
      properties: { note: { type: ["string", "null"], description: "n" }, n: { type: "integer", enum: [1] } },
      required: ["note"],
      additionalProperties: false,
    });
    expect(lossy).toBe(false);
    expect(schema).toEqual({
      type: "object",
      properties: { note: { type: "string", nullable: true, description: "n" }, n: { type: "integer" } },
      required: ["note"],
    });
  });
});

describe("OpenAI-compatible adapter on Gemini", () => {
  it("sends a lossy schema as json_object mode straight away (no 400 round trip)", async () => {
    const fetchMock = respond([]);
    await provider().complete({ ...request, schema: FLOW_BUILDER_JSON_SCHEMA });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock, 0).response_format).toEqual({ type: "json_object" });
  });

  it("retries a 400 ONCE with a degraded (json_object) request and succeeds", async () => {
    const fetchMock = respond([400, 200]);
    const result = await provider().complete(request);
    expect(result.json).toBe('{"reply":"Salom"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 0).response_format.type).toBe("json_schema");
    expect(bodyOf(fetchMock, 1).response_format).toEqual({ type: "json_object" });
  });

  it("a persistent 400 fails with a typed bad_request error and a plain Uzbek message", async () => {
    const fetchMock = respond([400, 400, 400]);
    const error = (await provider().complete(request).catch((e) => e)) as LlmError;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.kind).toBe("bad_request");
    expect(error.userMessage).toMatch(/Muammo:.*Sabab:.*Yechim:/);
  });

  it("retries 429 with backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = respond([429, 200]);
    const pending = provider().complete(request);
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).json).toBe('{"reply":"Salom"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 502 twice, then moves to the fallback model", async () => {
    vi.useFakeTimers();
    const fetchMock = respond([502, 502, 502, 200]);
    const pending = provider(["gemini-2.5-flash-lite"]).complete(request);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result.model).toBe("gemini-2.5-flash-lite");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("a timeout is typed as timeout and not retried on the same model (M4)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = provider().complete({ ...request, timeoutMs: 1000 });
    const assertion = expect(pending).rejects.toMatchObject({ name: "LlmError", kind: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs request metadata at warn level but never the prompt or the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respond([400, 400]);
    await provider().complete(request).catch(() => {});
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("gemini-3.1-flash-lite");
    expect(logged).toContain("status=400");
    expect(logged).toContain("response_format");
    expect(logged).not.toContain("SECRET SYSTEM PROMPT");
    expect(logged).not.toContain("narxi qancha");
    expect(logged).not.toContain("secret-key");
  });

  it("estimates tokens when the endpoint omits usage so cost is not silently zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"Salom"}' } }] }), { status: 200 })));
    const result = await provider().complete(request);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  });
});

describe("describeLlmFailure", () => {
  it("maps statuses to Uzbek messages", () => {
    expect(describeLlmFailure(new LlmError("x", 429))).toContain("limit");
    expect(describeLlmFailure(new LlmError("x", 503))).toContain("vaqtincha");
    expect(describeLlmFailure(new Error("boom"))).toContain("Muammo");
  });
});

describe("one counter source", () => {
  const rows = [
    ...Array.from({ length: 15 }, (_, i) => ({ ok: true, latencyMs: 1000 + i * 100 })),
    ...Array.from({ length: 8 }, () => ({ ok: false, latencyMs: 3000 })),
  ];

  it("summarises calls, failures, rate, avg and p95 from the same rows", () => {
    const stats = summarizeLlmRows(rows);
    expect(stats.calls).toBe(23);
    expect(stats.failures).toBe(8);
    expect(stats.errorRate).toBeCloseTo(0.3478, 3);
    expect(stats.p95LatencyMs).toBe(3000);
    expect(percentile([1, 2, 3, 4, 5], 95)).toBe(5);
  });

  it("flags a rate at or above 5% (with enough calls)", () => {
    expect(isLlmErrorRateHigh({ calls: 20, failures: 1 })).toBe(true);
    expect(isLlmErrorRateHigh({ calls: 100, failures: 4 })).toBe(false);
    expect(isLlmErrorRateHigh({ calls: 2, failures: 2 })).toBe(false);
  });

  it("Diagnostics shows Diqqat (warning) from that rate", () => {
    const item = buildAiCheck({ configured: true, model: "m", templateOnlyUntil: null, llm: { calls: 23, failures: 8, windowDays: 7 } }, new Date());
    expect(item.status).toBe("warning");
    expect(item.value).toContain("Diqqat");
    expect(buildAiCheck({ configured: true, model: "m", templateOnlyUntil: null, llm: { calls: 100, failures: 1, windowDays: 7 } }, new Date()).status).toBe("ok");
  });
});
