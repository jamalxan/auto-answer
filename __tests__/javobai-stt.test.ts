/**
 * ETAP 4.3 — Gemini native transcription: request shape, JSON parsing,
 * failure modes, cost/usage helpers, and the transcribeVoice provider
 * selection in lib/assistant/stt.ts. fetch is mocked throughout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeminiSttError,
  GeminiSttProvider,
  STT_LOW_CONFIDENCE,
  buildTranscriptionRequest,
  geminiAudioMime,
  geminiNativeBaseUrl,
  geminiSttModel,
  isGeminiSttConfigured,
  parseTranscriptText,
  parseTranscriptionResponse,
  sttCostUsd,
  sttUsageRecord,
  transcribeWithGemini,
} from "../lib/javobai/stt-gemini";
import { setSttProviderForTests, transcribeVoice } from "../lib/assistant/stt";

const audio = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 7)]);

function geminiOk(text: string, usage = { promptTokenCount: 300, candidatesTokenCount: 25 }) {
  return {
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { ...usage, totalTokenCount: usage.promptTokenCount + usage.candidatesTokenCount },
  };
}

function mockFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 200, body: geminiOk("{}") };
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setSttProviderForTests(undefined);
});

describe("configuration", () => {
  it("derives the native base url from LLM_BASE_URL by stripping /openai", () => {
    expect(geminiNativeBaseUrl({ LLM_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai" })).toBe(
      "https://generativelanguage.googleapis.com/v1beta"
    );
    expect(geminiNativeBaseUrl({ LLM_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/" })).toBe(
      "https://generativelanguage.googleapis.com/v1beta"
    );
    expect(geminiNativeBaseUrl({ GEMINI_NATIVE_BASE_URL: "https://proxy.example/v1beta/" })).toBe("https://proxy.example/v1beta");
    expect(geminiNativeBaseUrl({ LLM_BASE_URL: "http://localhost:11434/v1" })).toBe(
      "https://generativelanguage.googleapis.com/v1beta"
    );
    expect(geminiNativeBaseUrl({})).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("picks the model: JAVOBAI_STT_MODEL → JAVOBAI_MODEL_SMART → JAVOBAI_MODEL → LLM_MODEL", () => {
    expect(geminiSttModel({ LLM_MODEL: "gemini-3.1-flash-lite" })).toBe("gemini-3.1-flash-lite");
    expect(geminiSttModel({ LLM_MODEL: "a", JAVOBAI_MODEL: "b" })).toBe("b");
    expect(geminiSttModel({ LLM_MODEL: "a", JAVOBAI_MODEL: "b", JAVOBAI_MODEL_SMART: "c" })).toBe("c");
    expect(geminiSttModel({ LLM_MODEL: "a", JAVOBAI_MODEL_SMART: "c", JAVOBAI_STT_MODEL: "d" })).toBe("d");
    expect(geminiSttModel({})).toBeUndefined();
  });

  it("is configured only with a key on a Gemini stack", () => {
    expect(isGeminiSttConfigured({})).toBe(false);
    expect(isGeminiSttConfigured({ LLM_API_KEY: "k", LLM_MODEL: "claude-haiku-4-5" })).toBe(false);
    expect(isGeminiSttConfigured({ LLM_API_KEY: "k", LLM_MODEL: "gemini-3.1-flash-lite" })).toBe(true);
    expect(
      isGeminiSttConfigured({ LLM_API_KEY: "k", LLM_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai", LLM_MODEL: "x" })
    ).toBe(true);
    expect(isGeminiSttConfigured({ LLM_API_KEY: "k", GEMINI_NATIVE_BASE_URL: "https://proxy/v1beta" })).toBe(true);
  });

  it("spells media types the way the Gemini docs do", () => {
    expect(geminiAudioMime("audio/mpeg")).toBe("audio/mp3");
    expect(geminiAudioMime("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(geminiAudioMime("audio/x-m4a")).toBe("audio/mp4");
    expect(geminiAudioMime("audio/x-wav")).toBe("audio/wav");
    expect(geminiAudioMime("audio/aac")).toBe("audio/aac");
  });
});

describe("request shape (native generateContent)", () => {
  it("builds models/{model}:generateContent with x-goog-api-key and inline_data", () => {
    const request = buildTranscriptionRequest({
      base64: "QUJD",
      mime: "audio/ogg",
      model: "gemini-2.5-flash",
      apiKey: "secret",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      languageHint: "uz",
    });
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(request.headers).toEqual({ "content-type": "application/json", "x-goog-api-key": "secret" });
    expect(request.url).not.toContain("secret");

    const contents = request.body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts[0]).toEqual({ inline_data: { mime_type: "audio/ogg", data: "QUJD" } });
    const textPart = contents[0].parts[1] as { text: string };
    expect(textPart.text).toMatch(/verbatim/i);
    expect(textPart.text).toMatch(/Uzbek/);
    expect(textPart.text).toContain('"confidence"');

    const config = request.body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.temperature).toBe(0);
    expect(config.responseSchema).toMatchObject({ type: "OBJECT", required: ["text", "language", "confidence"] });
  });
});

describe("parsing", () => {
  it("parses plain JSON, fenced JSON and JSON with prose around it", () => {
    const expected = { text: "Narxi qancha?", language: "uz", confidence: 0.9, unstructured: false };
    expect(parseTranscriptText('{"text":"Narxi qancha?","language":"uz","confidence":0.9}')).toEqual(expected);
    expect(parseTranscriptText('```json\n{"text":"Narxi qancha?","language":"uz","confidence":0.9}\n```')).toEqual(expected);
    expect(parseTranscriptText('Here you go:\n{"text":"Narxi qancha?","language":"uz","confidence":0.9}\nDone.')).toEqual(expected);
  });

  it("normalises language and clamps confidence", () => {
    expect(parseTranscriptText('{"text":"Сколько стоит?","language":"Russian","confidence":"1.7"}')).toMatchObject({
      language: "ru",
      confidence: 1,
    });
    expect(parseTranscriptText('{"text":"hi","language":"en","confidence":-3}')).toMatchObject({ language: "other", confidence: 0 });
    expect(parseTranscriptText('{"text":"x"}')).toMatchObject({ language: "unknown", confidence: 0 });
  });

  it("accepts plain text as an unstructured transcript", () => {
    expect(parseTranscriptText("Assalomu alaykum, narxi qancha")).toEqual({
      text: "Assalomu alaykum, narxi qancha",
      language: "unknown",
      confidence: 0.5,
      unstructured: true,
    });
    expect(parseTranscriptText("{not json")).toMatchObject({ text: "{not json", unstructured: true });
    expect(parseTranscriptText("")).toMatchObject({ text: "", confidence: 0 });
  });

  it("reads the full native response with tokens", () => {
    const parsed = parseTranscriptionResponse(geminiOk('{"text":"Salom","language":"uz","confidence":0.8}'));
    expect(parsed).toMatchObject({ text: "Salom", inputTokens: 300, outputTokens: 25 });
  });

  it("throws on safety blocks and empty candidates", () => {
    expect(() => parseTranscriptionResponse({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/blocked/);
    expect(() => parseTranscriptionResponse({ candidates: [] })).toThrow(/empty/);
    expect(() => parseTranscriptionResponse({ candidates: [{ finishReason: "RECITATION" }] })).toThrow(/blocked/);
    expect(() => parseTranscriptionResponse(null)).toThrow(/empty/);
  });
});

describe("transcribeWithGemini", () => {
  it("posts the audio and returns text, confidence, tokens and cost", async () => {
    const { fetchImpl, calls } = mockFetch([{ body: geminiOk('{"text":"Narxi qancha?","language":"uz","confidence":0.92}') }]);
    const result = await transcribeWithGemini(
      { buffer: audio, mime: "audio/ogg", languageHint: "uz" },
      { apiKey: "k", model: "gemini-2.5-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta", fetchImpl }
    );
    expect(result).toMatchObject({
      text: "Narxi qancha?",
      language: "uz",
      confidence: 0.92,
      model: "gemini-2.5-flash",
      inputTokens: 300,
      outputTokens: 25,
      unstructured: false,
    });
    expect(result.costUsd).toBeCloseTo((300 * 0.3 + 25 * 2.5) / 1_000_000, 9);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body)) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(body.contents[0].parts[0].inline_data).toEqual({ mime_type: "audio/ogg", data: audio.toString("base64") });
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
  });

  it("reads key / model / base url from the environment", async () => {
    vi.stubEnv("LLM_API_KEY", "env-key");
    vi.stubEnv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai");
    vi.stubEnv("LLM_MODEL", "gemini-3.1-flash-lite");
    vi.stubEnv("JAVOBAI_MODEL_SMART", "gemini-2.5-flash");
    const { fetchImpl, calls } = mockFetch([{ body: geminiOk('{"text":"ok","language":"ru","confidence":0.7}') }]);
    const result = await transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { fetchImpl });
    expect(result.model).toBe("gemini-2.5-flash");
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  });

  it("fails fast when not configured", async () => {
    const { fetchImpl } = mockFetch([]);
    await expect(transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { fetchImpl, model: "m" })).rejects.toMatchObject({
      code: "not_configured",
    });
    await expect(transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { fetchImpl, apiKey: "k" })).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("surfaces HTTP errors with the status", async () => {
    const { fetchImpl } = mockFetch([{ status: 400, body: { error: { message: "Unsupported MIME type", status: "INVALID_ARGUMENT" } } }]);
    const error = await transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { apiKey: "k", model: "m", fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(GeminiSttError);
    expect(error.code).toBe("http");
    expect(error.status).toBe(400);
    expect(error.message).toContain("Unsupported MIME type");
  });

  it("retries once on a 503 and then succeeds", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = mockFetch([
      { status: 503, body: { error: { status: "UNAVAILABLE" } } },
      { body: geminiOk('{"text":"Salom","language":"uz","confidence":0.6}') },
    ]);
    const pending = transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { apiKey: "k", model: "m", fetchImpl });
    await vi.advanceTimersByTimeAsync(700);
    const result = await pending;
    expect(result.text).toBe("Salom");
    expect(calls).toHaveLength(2);
  });

  it("maps a safety block and an empty answer to errors", async () => {
    const blocked = mockFetch([{ body: { promptFeedback: { blockReason: "SAFETY" } } }]);
    await expect(
      transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { apiKey: "k", model: "m", fetchImpl: blocked.fetchImpl })
    ).rejects.toMatchObject({ code: "blocked" });
    const empty = mockFetch([{ body: { candidates: [{ content: { parts: [] } }] } }]);
    await expect(
      transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { apiKey: "k", model: "m", fetchImpl: empty.fetchImpl })
    ).rejects.toMatchObject({ code: "empty" });
    const garbage = mockFetch([{ body: "<html>" }]);
    await expect(
      transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { apiKey: "k", model: "m", fetchImpl: garbage.fetchImpl })
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("times out", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })
    ) as unknown as typeof fetch;
    await expect(
      transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { apiKey: "k", model: "m", fetchImpl, timeoutMs: 15 })
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("never puts audio bytes in an error message", async () => {
    const { fetchImpl } = mockFetch([{ status: 500, body: { error: { message: "boom" } } }, { status: 500, body: { error: { message: "boom" } } }]);
    vi.useFakeTimers();
    const pending = transcribeWithGemini({ buffer: audio, mime: "audio/ogg" }, { apiKey: "k", model: "m", fetchImpl }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(700);
    const error = await pending;
    expect(error.message).not.toContain(audio.toString("base64"));
  });

  it("the SpeechToTextProvider adapter returns the text", async () => {
    const { fetchImpl } = mockFetch([{ body: geminiOk('{"text":"Adapter","language":"uz","confidence":0.9}') }]);
    const provider = new GeminiSttProvider({ apiKey: "k", model: "m", fetchImpl });
    expect(provider.name).toBe("gemini");
    expect(await provider.transcribe(audio, "audio/ogg", "uz")).toBe("Adapter");
  });
});

describe("cost and usage helpers", () => {
  it("estimates with the text price table, or an explicit audio input price", () => {
    expect(sttCostUsd("gemini-2.5-flash", 1_000_000, 0, {})).toBeCloseTo(0.3, 9);
    expect(sttCostUsd("gemini-2.5-flash", 1_000_000, 1_000_000, { JAVOBAI_STT_COST_INPUT_PER_M: "1" })).toBeCloseTo(1 + 2.5, 9);
    expect(sttCostUsd("unknown-model", 100, 100, {})).toBe(0);
  });

  it("builds the LlmUsage row with kind javobai_stt", () => {
    const row = sttUsageRecord(
      { model: "gemini-2.5-flash", inputTokens: 300, outputTokens: 25, costUsd: 0.0001, latencyMs: 900 },
      { workspaceId: "ws1", conversationId: "c1" }
    );
    expect(row).toEqual({
      workspaceId: "ws1",
      conversationId: "c1",
      kind: "javobai_stt",
      model: "gemini-2.5-flash",
      inputTokens: 300,
      outputTokens: 25,
      costUsd: 0.0001,
      latencyMs: 900,
      ok: true,
    });
    expect(sttUsageRecord({ model: "m", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 10 }, { workspaceId: "ws1" }, false)).toMatchObject({
      conversationId: null,
      ok: false,
    });
  });

  it("exposes the low-confidence threshold the engine uses", () => {
    expect(STT_LOW_CONFIDENCE).toBe(0.4);
  });
});

describe("transcribeVoice (provider selection in lib/assistant/stt.ts)", () => {
  beforeEach(() => {
    vi.stubEnv("STT_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("LLM_BASE_URL", "");
    vi.stubEnv("LLM_MODEL", "");
    vi.stubEnv("GEMINI_NATIVE_BASE_URL", "");
  });

  it("returns null when neither Gemini nor Whisper is configured", async () => {
    setSttProviderForTests(null);
    expect(await transcribeVoice({ buffer: audio, mime: "audio/ogg" })).toBeNull();
  });

  it("uses Gemini when preferred and configured", async () => {
    vi.stubEnv("LLM_API_KEY", "k");
    vi.stubEnv("LLM_MODEL", "gemini-2.5-flash");
    vi.stubEnv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai");
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
      return new Response(JSON.stringify(geminiOk('{"text":"Gemini aytdi","language":"uz","confidence":0.88}')), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const whisper = { name: "fake", transcribe: vi.fn(async () => "whisper") };
    setSttProviderForTests(whisper);

    const result = await transcribeVoice({ buffer: audio, mime: "audio/ogg", languageHint: "uz" }, { preferred: "gemini" });
    expect(result).toMatchObject({ provider: "gemini", text: "Gemini aytdi", confidence: 0.88, language: "uz", model: "gemini-2.5-flash" });
    expect(whisper.transcribe).not.toHaveBeenCalled();
  });

  it("falls back to Whisper when Gemini fails, and reports the fallback", async () => {
    vi.stubEnv("LLM_API_KEY", "k");
    vi.stubEnv("LLM_MODEL", "gemini-2.5-flash");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 })));
    const whisper = { name: "fake", transcribe: vi.fn(async () => "whisper matni") };
    setSttProviderForTests(whisper);

    const result = await transcribeVoice({ buffer: audio, mime: "audio/ogg", languageHint: "ru" });
    expect(result).toMatchObject({ provider: "whisper", text: "whisper matni", confidence: null, costUsd: 0 });
    expect(result?.fallbackFrom).toMatchObject({ provider: "gemini" });
    expect(whisper.transcribe).toHaveBeenCalledWith(audio, "audio/ogg", "ru");
  });

  it("uses Whisper alone when Gemini is not configured (Anthropic stack)", async () => {
    vi.stubEnv("LLM_API_KEY", "k");
    vi.stubEnv("LLM_MODEL", "claude-haiku-4-5-20251001");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSttProviderForTests({ name: "fake", transcribe: async () => "only whisper" });
    const result = await transcribeVoice({ buffer: audio, mime: "audio/ogg" });
    expect(result).toMatchObject({ provider: "whisper", text: "only whisper" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours preferred: whisper", async () => {
    vi.stubEnv("LLM_API_KEY", "k");
    vi.stubEnv("LLM_MODEL", "gemini-2.5-flash");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setSttProviderForTests({ name: "fake", transcribe: async () => "whisper first" });
    const result = await transcribeVoice({ buffer: audio, mime: "audio/ogg" }, { preferred: "whisper" });
    expect(result?.provider).toBe("whisper");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when every configured provider failed", async () => {
    vi.stubEnv("LLM_API_KEY", "k");
    vi.stubEnv("LLM_MODEL", "gemini-2.5-flash");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    setSttProviderForTests({
      name: "fake",
      transcribe: async () => {
        throw new Error("whisper down");
      },
    });
    await expect(transcribeVoice({ buffer: audio, mime: "audio/ogg" })).rejects.toThrow("whisper down");
  });
});
