/**
 * JavobAI ETAP 4.3 — voice notes transcribed by Gemini (owner decision 4:
 * "Voice = Gemini native audio transcription with the existing LLM key").
 *
 * Production talks to Gemini through its OpenAI-compatible endpoint
 * (`LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`),
 * which has no audio input. This module calls the NATIVE Gemini API instead:
 *
 *   POST {GEMINI_NATIVE_BASE_URL}/models/{model}:generateContent
 *   x-goog-api-key: {LLM_API_KEY}
 *   { contents: [{ role: "user", parts: [{ inline_data: { mime_type, data } }, { text }] }],
 *     generationConfig: { responseMimeType: "application/json", ... } }
 *
 * The native base url is derived from LLM_BASE_URL by stripping the trailing
 * "/openai" (or set explicitly with GEMINI_NATIVE_BASE_URL). Model:
 * JAVOBAI_STT_MODEL → JAVOBAI_MODEL_SMART → JAVOBAI_MODEL → LLM_MODEL.
 *
 * Nothing here touches the database: `sttUsageRecord()` turns a result into
 * the row the engine hands to `recordJavobAiUsage()` (lib/javobai/usage.ts).
 * Audio bytes are never logged.
 */

import { calcCostUsd } from "@/lib/assistant/llm/provider";
import type { SpeechToTextProvider } from "@/lib/assistant/stt";

export const DEFAULT_GEMINI_NATIVE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_STT_TIMEOUT_MS = 30_000;
/** Below this the engine asks the customer to write instead (README "Voice and image"). */
export const STT_LOW_CONFIDENCE = 0.4;

export type SttLanguageHint = "uz" | "ru";
export type SttLanguage = "uz" | "ru" | "other" | "unknown";

export interface GeminiSttInput {
  buffer: Buffer;
  /** Sniffed media type from attachments.ts (audio/ogg, audio/mp4, audio/mpeg, audio/wav, audio/aac). */
  mime: string;
  languageHint?: SttLanguageHint;
}

export interface GeminiSttOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GeminiSttResult {
  text: string;
  language: SttLanguage;
  /** 0..1 as reported by the model (0 when it gave none). */
  confidence: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Estimate — see `sttCostUsd`. */
  costUsd: number;
  /** True when the model answered but not in the requested JSON shape. */
  unstructured: boolean;
}

export type GeminiSttErrorCode = "not_configured" | "timeout" | "http" | "blocked" | "empty" | "network";

export class GeminiSttError extends Error {
  constructor(
    public code: GeminiSttErrorCode,
    detail?: string,
    public status?: number
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GeminiSttError";
  }
}

// ─── Configuration ────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

/** Native API root: GEMINI_NATIVE_BASE_URL, else LLM_BASE_URL minus "/openai", else Google's default. */
export function geminiNativeBaseUrl(env: Env = process.env): string {
  const explicit = env.GEMINI_NATIVE_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const fromLlm = env.LLM_BASE_URL?.trim();
  if (fromLlm && /generativelanguage\.googleapis\.com/i.test(fromLlm)) {
    return fromLlm.replace(/\/+$/, "").replace(/\/openai$/i, "");
  }
  return DEFAULT_GEMINI_NATIVE_BASE_URL;
}

export function geminiSttModel(env: Env = process.env): string | undefined {
  return (
    env.JAVOBAI_STT_MODEL?.trim() ||
    env.JAVOBAI_MODEL_SMART?.trim() ||
    env.JAVOBAI_MODEL?.trim() ||
    env.LLM_MODEL?.trim() ||
    undefined
  );
}

export function geminiApiKey(env: Env = process.env): string | undefined {
  return env.LLM_API_KEY?.trim() || undefined;
}

/**
 * Gemini STT is usable when there is an LLM key and the stack is actually
 * Gemini (base url or model says so, or a native url is set explicitly) — an
 * Anthropic key would only produce 400s.
 */
export function isGeminiSttConfigured(env: Env = process.env): boolean {
  if (!geminiApiKey(env)) return false;
  if (env.GEMINI_NATIVE_BASE_URL?.trim()) return true;
  const base = env.LLM_BASE_URL ?? "";
  const model = geminiSttModel(env) ?? "";
  return /generativelanguage\.googleapis\.com/i.test(base) || /^gemini/i.test(model);
}

// ─── Request ──────────────────────────────────────────────────────────────────

/** Media types as the Gemini docs spell them (audio/mpeg → audio/mp3 etc.). */
export function geminiAudioMime(mime: string): string {
  const type = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (type) {
    case "audio/mpeg":
    case "audio/mp3":
      return "audio/mp3";
    case "audio/x-wav":
    case "audio/wave":
    case "audio/wav":
      return "audio/wav";
    case "audio/x-m4a":
    case "audio/m4a":
    case "audio/mp4":
      return "audio/mp4";
    case "audio/ogg":
    case "audio/opus":
      return "audio/ogg";
    default:
      return type || "audio/ogg";
  }
}

const LANGUAGE_NOTES: Record<SttLanguageHint, string> = {
  uz: "The customer most likely speaks Uzbek.",
  ru: "The customer most likely speaks Russian.",
};

export function transcriptionPrompt(languageHint?: SttLanguageHint): string {
  return [
    "You are a speech-to-text engine for an Instagram shop in Uzbekistan.",
    "Transcribe the audio verbatim. Do not translate, summarise, answer or add anything.",
    "Uzbek speech is written in Uzbek Latin script (o', g', sh, ch); Russian speech in Cyrillic.",
    languageHint ? LANGUAGE_NOTES[languageHint] : "The language is Uzbek or Russian.",
    'If there is no intelligible speech, return an empty "text".',
    'Return only JSON: {"text": string, "language": "uz" | "ru" | "other", "confidence": number from 0 to 1}.',
  ].join(" ");
}

/** OpenAPI-subset schema the native API takes in `generationConfig.responseSchema`. */
export const STT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    text: { type: "STRING" },
    language: { type: "STRING", enum: ["uz", "ru", "other"] },
    confidence: { type: "NUMBER" },
  },
  required: ["text", "language", "confidence"],
} as const;

export interface GeminiRequestShape {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Pure: the exact HTTP request for one transcription (tests assert on it). */
export function buildTranscriptionRequest(input: {
  base64: string;
  mime: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  languageHint?: SttLanguageHint;
}): GeminiRequestShape {
  const base = (input.baseUrl ?? DEFAULT_GEMINI_NATIVE_BASE_URL).replace(/\/+$/, "");
  return {
    url: `${base}/models/${encodeURIComponent(input.model)}:generateContent`,
    headers: { "content-type": "application/json", "x-goog-api-key": input.apiKey },
    body: {
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: geminiAudioMime(input.mime), data: input.base64 } },
            { text: transcriptionPrompt(input.languageHint) },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
        responseSchema: STT_RESPONSE_SCHEMA,
      },
    },
  };
}

// ─── Response parsing ─────────────────────────────────────────────────────────

interface GeminiNativeResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { message?: string; status?: string };
}

export interface ParsedTranscript {
  text: string;
  language: SttLanguage;
  confidence: number;
  unstructured: boolean;
}

function clamp01(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function normalizeLanguage(value: unknown): SttLanguage {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "uz" || v.startsWith("uzb")) return "uz";
  if (v === "ru" || v.startsWith("rus")) return "ru";
  if (v) return "other";
  return "unknown";
}

/** Strip ```json fences and anything around the outermost object. */
function extractJsonObject(raw: string): string | null {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Model text → transcript. JSON (possibly fenced) is preferred; plain text is
 * accepted as the transcript itself with a middling confidence so one odd
 * answer does not throw a voice note away.
 */
export function parseTranscriptText(raw: string): ParsedTranscript {
  const candidate = extractJsonObject(raw);
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const text = typeof obj.text === "string" ? obj.text.trim() : "";
        return {
          text,
          language: normalizeLanguage(obj.language),
          confidence: clamp01(obj.confidence),
          unstructured: false,
        };
      }
    } catch {
      // fall through to plain text
    }
  }
  const plain = raw.replace(/```(?:json)?/gi, "").trim();
  return { text: plain, language: "unknown", confidence: plain ? 0.5 : 0, unstructured: true };
}

/** Full native response → transcript (+ tokens). Throws on block / empty. */
export function parseTranscriptionResponse(data: unknown): ParsedTranscript & { inputTokens: number; outputTokens: number } {
  const body = (data ?? {}) as GeminiNativeResponse;
  if (body.promptFeedback?.blockReason) {
    throw new GeminiSttError("blocked", body.promptFeedback.blockReason);
  }
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
  const finish = body.candidates?.[0]?.finishReason;
  if (!text) {
    if (finish && finish !== "STOP" && finish !== "MAX_TOKENS") throw new GeminiSttError("blocked", finish);
    throw new GeminiSttError("empty", "no text in candidates");
  }
  return {
    ...parseTranscriptText(text),
    inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

// ─── Cost ─────────────────────────────────────────────────────────────────────

/**
 * USD estimate for one transcription. Uses the per-model text prices from
 * provider.ts (`calcCostUsd`). TODO (4.4): Gemini bills audio input tokens at
 * a higher rate than text (e.g. 2.5 Flash: $1.00/M audio vs $0.30/M text), so
 * this is a lower bound unless JAVOBAI_STT_COST_INPUT_PER_M is set.
 */
export function sttCostUsd(model: string, inputTokens: number, outputTokens: number, env: Env = process.env): number {
  const audioIn = Number(env.JAVOBAI_STT_COST_INPUT_PER_M);
  if (Number.isFinite(audioIn) && audioIn > 0) {
    const textOnly = calcCostUsd(model, 0, outputTokens);
    return textOnly + (inputTokens * audioIn) / 1_000_000;
  }
  return calcCostUsd(model, inputTokens, outputTokens);
}

// ─── Call ─────────────────────────────────────────────────────────────────────

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 600;

async function post(
  fetchImpl: typeof fetch,
  request: GeminiRequestShape,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new GeminiSttError("timeout", `after ${timeoutMs}ms`);
    }
    throw new GeminiSttError("network", error instanceof Error ? error.message : "network error");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribe one voice note. Throws `GeminiSttError`; never logs audio.
 * One quick retry on a transient status (Gemini answers 503 under load).
 */
export async function transcribeWithGemini(input: GeminiSttInput, options: GeminiSttOptions = {}): Promise<GeminiSttResult> {
  const apiKey = options.apiKey ?? geminiApiKey();
  const model = options.model ?? geminiSttModel();
  if (!apiKey || !model) throw new GeminiSttError("not_configured", !apiKey ? "LLM_API_KEY" : "model");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS;

  const request = buildTranscriptionRequest({
    base64: input.buffer.toString("base64"),
    mime: input.mime,
    model,
    apiKey,
    baseUrl: options.baseUrl ?? geminiNativeBaseUrl(),
    languageHint: input.languageHint,
  });

  const started = Date.now();
  let response = await post(fetchImpl, request, timeoutMs);
  if (RETRY_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    response = await post(fetchImpl, request, timeoutMs);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GeminiSttError("http", `${response.status}: ${text.slice(0, 200)}`, response.status);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new GeminiSttError("empty", "non-JSON body");
  }
  const parsed = parseTranscriptionResponse(data);
  const latencyMs = Date.now() - started;
  return {
    text: parsed.text,
    language: parsed.language,
    confidence: parsed.confidence,
    unstructured: parsed.unstructured,
    model,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    latencyMs,
    costUsd: sttCostUsd(model, parsed.inputTokens, parsed.outputTokens),
  };
}

// ─── Usage row ────────────────────────────────────────────────────────────────

/** Same shape as `RecordJavobAiUsageInput` (lib/javobai/usage.ts), kind "javobai_stt". */
export interface SttUsageRecord {
  workspaceId: string;
  conversationId: string | null;
  kind: "javobai_stt";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
}

/**
 * The row the engine passes to `recordJavobAiUsage()`. For a failed call pass
 * `ok: false` with whatever is known (model, latency) so failures are counted.
 */
export function sttUsageRecord(
  result: Pick<GeminiSttResult, "model" | "inputTokens" | "outputTokens" | "costUsd" | "latencyMs">,
  scope: { workspaceId: string; conversationId?: string | null },
  ok = true
): SttUsageRecord {
  return {
    workspaceId: scope.workspaceId,
    conversationId: scope.conversationId ?? null,
    kind: "javobai_stt",
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    ok,
  };
}

// ─── SpeechToTextProvider adapter ─────────────────────────────────────────────

/**
 * The design doc's `GeminiSttProvider`: the same interface as the Whisper
 * provider (text only), for code paths that only want a string. The engine
 * should prefer `transcribeWithGemini` / `transcribeVoice` to keep confidence
 * and cost.
 */
export class GeminiSttProvider implements SpeechToTextProvider {
  readonly name = "gemini";
  constructor(private options: GeminiSttOptions = {}) {}

  async transcribe(audio: Buffer, mimeType: string, language?: string): Promise<string> {
    const hint = language === "uz" || language === "ru" ? language : undefined;
    const result = await transcribeWithGemini({ buffer: audio, mime: mimeType, languageHint: hint }, this.options);
    return result.text;
  }
}
