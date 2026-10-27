/**
 * LLM provider abstraction (TZ 4.3). The assistant only talks to `LLMProvider`;
 * the concrete provider is picked from `.env`:
 *
 *   LLM_PROVIDER = anthropic | openai        (openai also covers any
 *                                              OpenAI-compatible endpoint via LLM_BASE_URL)
 *   LLM_MODEL    = model id (cheap + fast; reply must come back in ~3s)
 *   LLM_API_KEY  = key (falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY)
 *   LLM_FALLBACK_MODELS = optional comma list (openai only), tried in order
 *                 when LLM_MODEL is overloaded / rate limited
 *   LLM_TIMEOUT_MS = per-request timeout (default 15000)
 *   LLM_TOTAL_BUDGET_MS = overall deadline across primary + fallbacks + retries
 *                 (default 25000, never below the per-request timeout unless set)
 *   LLM_FALLBACK_PROVIDER / _API_KEY / _MODEL / _BASE_URL = optional SECOND
 *                 provider (another vendor), asked once when the primary's whole
 *                 chain failed — a vendor-wide outage no longer fails every reply
 *
 * EVERY caller goes through `complete()`, so the OpenAI-compatible adapter below
 * is the one place that: sanitises the JSON schema for Gemini, times out, retries
 * (429 / 5xx / timeout with backoff; a 400 once with a degraded request), walks
 * the fallback model chain, logs request METADATA only (never prompts or keys)
 * and raises a typed `LlmError` with a plain Uzbek message.
 */

import { isGeminiTarget, sanitizeSchemaForGemini } from "./gemini-schema";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmImage {
  mediaType: string;
  base64: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  /** JSON Schema of the structured answer. */
  schema: Record<string, unknown>;
  schemaName: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Optional images (vision requests: price-list photos). */
  images?: LlmImage[];
  /**
   * When set, the adapter records the call outcome in `llm_usage` (the single
   * counter source). Callers that already write their own usage row leave it unset.
   */
  usage?: { workspaceId: string; kind: string; conversationId?: string | null };
}

export interface LlmResponse {
  /** Parsed structured answer (object) or raw text when the model ignored the schema. */
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  model: string;
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** USD for a call, used for the `llm_usage` table. `model` is the one that answered (a fallback may have). */
  costUsd(inputTokens: number, outputTokens: number, model?: string): number;
}

export type LlmErrorKind = "timeout" | "network" | "rate_limit" | "upstream" | "bad_request" | "auth" | "not_found" | "unknown";

export function llmErrorKindFor(status: number | undefined): LlmErrorKind {
  if (status === undefined) return "network";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream";
  if (status === 400 || status === 422) return "bad_request";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  return "unknown";
}

/** Plain Uzbek message in Muammo / Sabab / Yechim style, safe to show in the UI. */
export function llmUserMessage(kind: LlmErrorKind): string {
  switch (kind) {
    case "timeout":
      return "Muammo: AI vaqtida javob bermadi. Sabab: model band yoki tarmoq sekin. Yechim: bir necha soniyadan keyin qayta urinib ko'ring.";
    case "network":
      return "Muammo: AI xizmatiga ulanib bo'lmadi. Sabab: tarmoq xatosi. Yechim: birozdan keyin qayta urinib ko'ring.";
    case "rate_limit":
      return "Muammo: AI so'rovlari limiti to'ldi. Sabab: provider qisqa muddat cheklov qo'ydi. Yechim: 1 daqiqadan keyin qayta urinib ko'ring.";
    case "upstream":
      return "Muammo: AI provider vaqtincha ishlamayapti. Sabab: model haddan tashqari band (5xx). Yechim: bir ozdan keyin qayta urinib ko'ring.";
    case "bad_request":
      return "Muammo: AI so'rovi qabul qilinmadi. Sabab: provider so'rov formatini rad etdi. Yechim: qayta urinib ko'ring; takrorlansa dasturchiga xabar bering.";
    case "auth":
      return "Muammo: AI kaliti ishlamayapti. Sabab: API kalit noto'g'ri yoki limiti tugagan. Yechim: serverda LLM_API_KEY ni tekshiring.";
    case "not_found":
      return "Muammo: AI modeli topilmadi. Sabab: LLM_MODEL noto'g'ri nomlangan. Yechim: serverda model nomini tekshiring.";
    default:
      return "Muammo: AI javob bermadi. Sabab: noma'lum xato. Yechim: qayta urinib ko'ring.";
  }
}

/** Longest LlmError.message (it reaches logs / events): kind + status only, never a provider body. */
export const LLM_ERROR_MESSAGE_MAX = 120;

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  /** Plain Uzbek explanation for the UI (never contains prompts / keys / provider body). */
  readonly userMessage: string;
  attempts = 1;
  latencyMs = 0;
  model?: string;
  /**
   * Raw provider response body (first 300 chars) for local debugging ONLY. It is
   * not part of `message`, must never be persisted, logged or shown.
   */
  debugBody?: string;
  constructor(
    message: string,
    public status?: number,
    kind?: LlmErrorKind,
    debugBody?: string
  ) {
    super(message.slice(0, LLM_ERROR_MESSAGE_MAX));
    if (debugBody) this.debugBody = debugBody.slice(0, 300);
    this.name = "LlmError";
    this.kind = kind ?? llmErrorKindFor(status);
    this.userMessage = llmUserMessage(this.kind);
  }
}

/**
 * The `llm_usage.errorKind` of a failed call: the typed kind of an LlmError, or
 * "internal" for anything else (a bug in our code around the call). An internal
 * failure is logged with its type and code location only — the message may
 * carry a provider body or a key, so it never reaches the log.
 */
export function failureKindOf(error: unknown, where = "llm"): string {
  if (error instanceof LlmError) return error.kind;
  const name = error instanceof Error ? error.name : typeof error;
  const frame = error instanceof Error ? (error.stack ?? "").split(/\r?\n/).find((line) => line.trim().startsWith("at "))?.trim().slice(0, 160) : undefined;
  console.error(`[LLM] internal failure in ${where}: ${name}${frame ? ` ${frame}` : ""}`);
  return "internal";
}

/** Plain Uzbek message for any thrown value. */
export function describeLlmFailure(error: unknown): string {
  return error instanceof LlmError ? error.userMessage : llmUserMessage("unknown");
}

// USD per 1M tokens (input, output). Unknown models use LLM_COST_* env or 0.
// Gemini: Google's public list prices (standard tier, prompts up to 200k
// tokens) as known at the time of writing — update when Google changes them.
// Most specific patterns first: "flash-lite" must win over "flash".
const PRICES: Array<[RegExp, number, number]> = [
  [/haiku-4-5|haiku/i, 1, 5],
  [/sonnet/i, 3, 15],
  [/opus/i, 5, 25],
  [/gpt-4o-mini|gpt-4\.1-mini|gpt-5-mini/i, 0.15, 0.6],
  [/gpt-4o|gpt-4\.1/i, 2.5, 10],
  [/gemini-3(?:\.\d+)?-flash-lite/i, 0.25, 1.5],
  [/gemini-3(?:\.\d+)?-flash/i, 0.5, 3],
  [/gemini-3(?:\.\d+)?-pro/i, 2, 12],
  [/gemini-2\.5-flash-lite/i, 0.1, 0.4],
  [/gemini-2\.5-flash/i, 0.3, 2.5],
  [/gemini-2\.5-pro/i, 1.25, 10],
  [/gemini-2\.0-flash-lite/i, 0.075, 0.3],
  [/gemini-2\.0-flash/i, 0.1, 0.4],
  // Any other Gemini id: priced like the family it names.
  [/gemini.*flash-lite/i, 0.1, 0.4],
  [/gemini.*flash/i, 0.3, 2.5],
  [/gemini.*pro/i, 1.25, 10],
];

/** Per-request timeout. Local models (Ollama) need far more than a hosted API. */
export function llmTimeoutMs(fallback = 15_000): number {
  const value = Number(process.env.LLM_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Timeout for long generations (AI Flow Builder, ManyChat conversion, reply
 * variants). LLM_TIMEOUT_MS is tuned for chat turns (a few seconds); applied as
 * a ceiling it made every big JSON generation fail with "AI vaqtida javob
 * bermadi". So here the env value is a floor, never a cap: the job gets at least
 * `minimum` ms, more when the owner configured more.
 */
export function llmLongTimeoutMs(minimum: number): number {
  return Math.max(llmTimeoutMs(minimum), minimum);
}

/**
 * `LLM_PRICES='{"gemini-3.1-flash-lite":[0.25,1.5]}'` — per-model USD per 1M tokens
 * (input, output), matched by substring. Wins over the built-in table; lets the
 * owner correct a price without a deploy.
 */
function priceFromEnvTable(model: string): [number, number] | null {
  const raw = process.env.LLM_PRICES;
  if (!raw) return null;
  try {
    const table = JSON.parse(raw) as Record<string, unknown>;
    const key = Object.keys(table)
      .filter((k) => model.toLowerCase().includes(k.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
    const value = key ? table[key] : null;
    if (Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(Number(n)))) return [Number(value[0]), Number(value[1])];
  } catch {
    // bad JSON: ignore, the built-in table is used
  }
  return null;
}

export function priceFor(model: string): [number, number] {
  const fromTable = priceFromEnvTable(model);
  if (fromTable) return fromTable;
  const envIn = Number(process.env.LLM_COST_INPUT_PER_M);
  const envOut = Number(process.env.LLM_COST_OUTPUT_PER_M);
  if (Number.isFinite(envIn) && Number.isFinite(envOut) && (envIn > 0 || envOut > 0)) {
    return [envIn, envOut];
  }
  for (const [pattern, input, output] of PRICES) {
    if (pattern.test(model)) return [input, output];
  }
  return [0, 0];
}

export function calcCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [pin, pout] = priceFor(model);
  return (inputTokens * pin + outputTokens * pout) / 1_000_000;
}

/** Overall deadline for one `complete()` call (primary + fallbacks + retries). */
export function llmTotalBudgetMs(requestTimeoutMs = llmTimeoutMs()): number {
  const value = Number(process.env.LLM_TOTAL_BUDGET_MS);
  if (Number.isFinite(value) && value > 0) return value;
  return Math.max(25_000, requestTimeoutMs);
}

/** Below this much remaining budget a new attempt is not worth starting. */
const MIN_ATTEMPT_MS = 500;

function budgetExhausted(): LlmError {
  return new LlmError("LLM total time budget exhausted", undefined, "timeout");
}

async function fetchOnce(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new LlmError(`LLM request timed out after ${timeoutMs}ms`, undefined, "timeout");
    }
    throw new LlmError(error instanceof Error ? error.message : "LLM network error");
  } finally {
    clearTimeout(timer);
  }
}

/** Statuses a hosted model returns when it is briefly overloaded or rate limited. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Short waits: a chat reply should still land within a few seconds. */
export const LLM_RETRY_DELAYS_MS = [400, 1200];

/**
 * One request with up to two quick retries on a transient status. Gemini in
 * particular answers 503 "model is overloaded" for a moment under load; one
 * such blip used to fail the whole reply (or the profile autofill).
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, deadline: number) {
  let response = await fetchOnce(url, init, Math.max(MIN_ATTEMPT_MS, Math.min(timeoutMs, deadline - Date.now())));
  // A timeout throws out of fetchOnce: it is never retried on the same model.
  for (const delay of LLM_RETRY_DELAYS_MS) {
    if (!TRANSIENT_STATUSES.has(response.status)) break;
    // Not enough budget for the wait plus a useful attempt: hand this response back (the caller raises its error).
    if (deadline - Date.now() < delay + MIN_ATTEMPT_MS) break;
    await response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delay));
    response = await fetchOnce(url, init, Math.max(MIN_ATTEMPT_MS, Math.min(timeoutMs, deadline - Date.now())));
  }
  return response;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  constructor(
    private apiKey: string,
    readonly model: string,
    private baseUrl = "https://api.anthropic.com"
  ) {}

  costUsd(i: number, o: number, model = this.model) {
    return calcCostUsd(model, i, o);
  }

  complete(req: LlmRequest): Promise<LlmResponse> {
    return trackOutcome(req, this.model, (m, i, o) => this.costUsd(i, o, m), () => this.run(req));
  }

  private async run(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const requestTimeout = req.timeoutMs ?? llmTimeoutMs();
    const deadline = started + llmTotalBudgetMs(requestTimeout);
    const messages = req.messages.map((m, idx) => {
      const isLastUser = idx === req.messages.length - 1 && m.role === "user";
      if (isLastUser && req.images?.length) {
        return {
          role: m.role,
          content: [
            ...req.images.map((img) => ({
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.base64 },
            })),
            { type: "text", text: m.content },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    const response = await fetchWithTimeout(
      `${this.baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens ?? 600,
          temperature: req.temperature ?? 0.4,
          system: req.system,
          messages,
          tools: [
            {
              name: req.schemaName,
              description: "Return the structured answer.",
              input_schema: req.schema,
            },
          ],
          tool_choice: { type: "tool", name: req.schemaName },
        }),
      },
      requestTimeout,
      deadline
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LlmError(`Anthropic ${response.status}`, response.status, undefined, body);
    }
    const data = (await response.json()) as {
      content?: Array<{ type: string; input?: unknown; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const toolUse = data.content?.find((c) => c.type === "tool_use");
    const text = data.content?.find((c) => c.type === "text")?.text;
    return {
      json: toolUse?.input ?? text ?? null,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai";
  constructor(
    private apiKey: string,
    readonly model: string,
    private baseUrl = "https://api.openai.com/v1",
    /** Tried in order when `model` is still overloaded after its retries. */
    private fallbackModels: string[] = []
  ) {}

  costUsd(i: number, o: number, model = this.model) {
    return calcCostUsd(model, i, o);
  }

  complete(req: LlmRequest): Promise<LlmResponse> {
    return trackOutcome(req, this.model, (m, i, o) => this.costUsd(i, o, m), () => this.run(req));
  }

  private async run(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: req.system }];
    req.messages.forEach((m, idx) => {
      const isLastUser = idx === req.messages.length - 1 && m.role === "user";
      if (isLastUser && req.images?.length) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: m.content },
            ...req.images.map((img) => ({
              type: "image_url",
              image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
            })),
          ],
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    });

    const timeoutMs = req.timeoutMs ?? llmTimeoutMs();
    // One deadline for primary + fallbacks + retries (LLM_TOTAL_BUDGET_MS).
    const deadline = started + llmTotalBudgetMs(timeoutMs);
    let attempts = 0;
    let lastError: LlmError | null = null;

    // A hosted model can stay "overloaded" for hours (Gemini 503 UNAVAILABLE);
    // move on to the next configured model instead of failing every reply.
    for (const model of [this.model, ...this.fallbackModels]) {
      if (deadline - Date.now() < MIN_ATTEMPT_MS) {
        // Budget spent: stop with a typed timeout error.
        lastError = budgetExhausted();
        break;
      }
      const outcome = await this.callModel(model, req, messages, timeoutMs, deadline, () => {
        attempts += 1;
      });
      if (!(outcome instanceof LlmError)) {
        return { ...outcome, latencyMs: Date.now() - started };
      }
      lastError = outcome;
      // 400 / auth / not found do not heal on another model: stop here.
      if (!isTransientError(outcome)) break;
    }
    const error = lastError ?? new LlmError("LLM failed");
    error.attempts = attempts;
    error.latencyMs = Date.now() - started;
    throw error;
  }

  /** One model: retries on transient failures, one degraded retry on a 400. */
  private async callModel(
    model: string,
    req: LlmRequest,
    messages: Array<Record<string, unknown>>,
    timeoutMs: number,
    deadline: number,
    onAttempt: () => void
  ): Promise<LlmResponse | LlmError> {
    const gemini = isGeminiTarget(this.baseUrl, model);
    const sanitized = gemini ? sanitizeSchemaForGemini(req.schema) : null;
    let mode: "schema" | "json_object" = sanitized?.lossy ? "json_object" : "schema";
    let degraded = mode === "json_object";
    let transientRetries = 0;

    for (;;) {
      onAttempt();
      const started = Date.now();
      const body = this.buildBody(model, req, messages, mode, sanitized?.schema ?? req.schema);
      let status: number | undefined;
      let error: LlmError | null = null;
      let response: Response | null = null;
      try {
        response = await fetchOnce(
          `${this.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
          },
          Math.max(MIN_ATTEMPT_MS, Math.min(timeoutMs, deadline - Date.now()))
        );
        status = response.status;
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          error = new LlmError(`OpenAI ${response.status}`, response.status, undefined, text);
        }
      } catch (caught) {
        error = caught instanceof LlmError ? caught : new LlmError(caught instanceof Error ? caught.message : "LLM network error");
      }

      if (!error && response) {
        const data = (await response.json().catch(() => null)) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        } | null;
        const content = data?.choices?.[0]?.message?.content ?? null;
        let inputTokens = data?.usage?.prompt_tokens ?? 0;
        let outputTokens = data?.usage?.completion_tokens ?? 0;
        // Some compatible endpoints omit usage: estimate (~4 chars/token) so cost is never silently $0.
        if (!inputTokens) inputTokens = estimateTokens(messages.map((m) => (typeof m.content === "string" ? m.content : "")).join(" "));
        if (!outputTokens && content) outputTokens = estimateTokens(content);
        return { json: content, inputTokens, outputTokens, model, latencyMs: 0 };
      }

      const failure = error ?? new LlmError("LLM failed");
      failure.model = model;
      logLlmFailure({
        model,
        mode,
        params: Object.keys(body),
        status,
        kind: failure.kind,
        latencyMs: Date.now() - started,
        degraded,
        attempt: transientRetries + 1,
      });

      if (failure.kind === "bad_request" && !degraded) {
        // Provider rejected an argument: retry ONCE with plain json_object mode (no schema).
        degraded = true;
        mode = "json_object";
        continue;
      }
      // A timeout is not retried on the same model (it would burn the budget again): the next model gets its go.
      if (failure.kind === "timeout") return failure;
      if (
        isTransientError(failure) &&
        transientRetries < LLM_RETRY_DELAYS_MS.length &&
        deadline - Date.now() >= LLM_RETRY_DELAYS_MS[transientRetries] + MIN_ATTEMPT_MS
      ) {
        await new Promise((resolve) => setTimeout(resolve, LLM_RETRY_DELAYS_MS[transientRetries]));
        transientRetries += 1;
        continue;
      }
      return failure;
    }
  }

  private buildBody(
    model: string,
    req: LlmRequest,
    messages: Array<Record<string, unknown>>,
    mode: "schema" | "json_object",
    schema: Record<string, unknown>
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      model,
      temperature: req.temperature ?? 0.4,
      max_tokens: req.maxTokens ?? 600,
    };
    if (mode === "schema") {
      return {
        ...base,
        messages,
        response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema } },
      };
    }
    // json_object mode carries no schema: describe the shape in the system prompt instead.
    const hint = `\n\nJavobni FAQAT bitta JSON obyekt sifatida qaytaring. JSON Schema: ${JSON.stringify(req.schema).slice(0, 6000)}`;
    const withHint = messages.map((m, i) => (i === 0 && typeof m.content === "string" ? { ...m, content: m.content + hint } : m));
    return { ...base, messages: withHint, response_format: { type: "json_object" } };
  }
}

function isTransientError(error: LlmError): boolean {
  return error.kind === "timeout" || error.kind === "network" || error.kind === "rate_limit" || error.kind === "upstream";
}

function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

/** Request METADATA only: never the prompt, the messages or the key. */
function logLlmFailure(meta: {
  model: string;
  mode: string;
  params: string[];
  status: number | undefined;
  kind: LlmErrorKind;
  latencyMs: number;
  degraded: boolean;
  attempt: number;
}) {
  console.warn(
    `[LLM] request failed model=${meta.model} status=${meta.status ?? "none"} kind=${meta.kind} mode=${meta.mode} degraded=${meta.degraded} attempt=${meta.attempt} latencyMs=${meta.latencyMs} params=${meta.params.join(",")}`
  );
}

/**
 * Runs one LLM call and, when the request carries `usage`, records its outcome
 * ONCE in `llm_usage` (success or failure, tokens, cost, latency, model) — the
 * single counter source read by Diagnostics, Analytics and JavobAI usage.
 */
async function trackOutcome(
  req: LlmRequest,
  defaultModel: string,
  cost: (model: string, input: number, output: number) => number,
  run: () => Promise<LlmResponse>
): Promise<LlmResponse> {
  const started = Date.now();
  try {
    const response = await run();
    if (req.usage) {
      await writeUsage(req.usage, {
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: cost(response.model, response.inputTokens, response.outputTokens),
        latencyMs: response.latencyMs,
        ok: true,
        errorKind: null,
      });
    }
    return response;
  } catch (error) {
    if (req.usage) {
      await writeUsage(req.usage, {
        model: error instanceof LlmError && error.model ? error.model : defaultModel,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: error instanceof LlmError && error.latencyMs ? error.latencyMs : Date.now() - started,
        ok: false,
        errorKind: failureKindOf(error, req.usage.kind),
      });
    }
    throw error;
  }
}

async function writeUsage(
  ctx: NonNullable<LlmRequest["usage"]>,
  row: { model: string; inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; ok: boolean; errorKind: string | null }
) {
  try {
    const { prisma } = await import("@/lib/db/client");
    await prisma.llmUsage.create({
      data: {
        workspaceId: ctx.workspaceId,
        conversationId: ctx.conversationId ?? null,
        kind: ctx.kind,
        model: row.model,
        inputTokens: Math.max(0, Math.round(row.inputTokens) || 0),
        outputTokens: Math.max(0, Math.round(row.outputTokens) || 0),
        costUsd: Math.round(Math.max(0, row.costUsd) * 1_000_000) / 1_000_000,
        latencyMs: Math.max(0, Math.round(row.latencyMs) || 0),
        ok: row.ok,
        errorKind: row.ok ? null : row.errorKind,
      },
    });
  } catch (error) {
    console.error("[LLM] usage write failed:", error instanceof Error ? error.message : error);
  }
}

/** `LLM_FALLBACK_MODELS=a,b` -> ["a", "b"]. */
export function fallbackModelsFromEnv(value = process.env.LLM_FALLBACK_MODELS): string[] {
  return (value ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * Primary provider with a second vendor behind it. The primary's own chain
 * (retries, fallback models) runs first; on any LlmError the secondary gets
 * one go with the same request. Usage is tracked once, here, for the call as a
 * whole: the customer either got an answer (ok) or did not.
 */
export class FailoverProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  constructor(
    private primary: LLMProvider,
    private secondary: LLMProvider
  ) {
    this.name = `${primary.name}+${secondary.name}`;
    this.model = primary.model;
  }

  costUsd(i: number, o: number, model = this.model) {
    return model === this.secondary.model ? this.secondary.costUsd(i, o, model) : this.primary.costUsd(i, o, model);
  }

  complete(req: LlmRequest): Promise<LlmResponse> {
    const inner: LlmRequest = { ...req, usage: undefined };
    return trackOutcome(req, this.model, (m, i, o) => this.costUsd(i, o, m), async () => {
      const started = Date.now();
      try {
        return await this.primary.complete(inner);
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        console.warn(`[LLM] primary ${this.primary.model} failed (${error.kind}), trying ${this.secondary.name}:${this.secondary.model}`);
        try {
          const response = await this.secondary.complete(inner);
          return { ...response, latencyMs: Date.now() - started };
        } catch (secondError) {
          if (secondError instanceof LlmError) secondError.latencyMs = Date.now() - started;
          throw secondError;
        }
      }
    });
  }
}

/** The configured second vendor (LLM_FALLBACK_PROVIDER), or null. */
export function fallbackProviderFromEnv(env: Record<string, string | undefined> = process.env): LLMProvider | null {
  const kind = (env.LLM_FALLBACK_PROVIDER ?? "").toLowerCase();
  const key = env.LLM_FALLBACK_API_KEY;
  if (!kind || !key) return null;
  if (kind === "anthropic") return new AnthropicProvider(key, env.LLM_FALLBACK_MODEL || "claude-haiku-4-5-20251001", env.LLM_FALLBACK_BASE_URL || undefined);
  if (kind === "openai") return new OpenAICompatibleProvider(key, env.LLM_FALLBACK_MODEL || "gpt-4o-mini", env.LLM_FALLBACK_BASE_URL || undefined);
  return null;
}

function withFailover(primary: LLMProvider): LLMProvider {
  const secondary = fallbackProviderFromEnv();
  return secondary ? new FailoverProvider(primary, secondary) : primary;
}

let override: LLMProvider | null | undefined;

/** Tests (and the sandbox) can inject a provider. Pass undefined to reset. */
export function setLlmProviderForTests(provider: LLMProvider | null | undefined) {
  override = provider;
}

export function getLlmProvider(): LLMProvider | null {
  return getLlmProviderFor(process.env.LLM_MODEL);
}

/**
 * The same provider (kind, key, base URL, fallback list) for a different
 * model id — JavobAI routes its turns through JAVOBAI_MODEL / _SMART without
 * touching production's `getLlmProvider()`. Undefined = the LLM_MODEL default.
 */
export function getLlmProviderFor(model?: string): LLMProvider | null {
  if (override !== undefined) return override;
  const kind = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  model = model ?? process.env.LLM_MODEL;

  if (kind === "openai") {
    const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!key) return null;
    return withFailover(
      new OpenAICompatibleProvider(key, model ?? "gpt-4o-mini", process.env.LLM_BASE_URL ?? undefined, fallbackModelsFromEnv())
    );
  }

  const key = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (kind === "anthropic" || (!kind && key)) {
    if (!key) return null;
    return withFailover(new AnthropicProvider(key, model ?? "claude-haiku-4-5-20251001", process.env.LLM_BASE_URL ?? undefined));
  }
  return null;
}
