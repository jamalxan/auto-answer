/**
 * LLM provider abstraction (TZ 4.3). The assistant only talks to `LLMProvider`;
 * the concrete provider is picked from `.env`:
 *
 *   LLM_PROVIDER = anthropic | openai        (openai also covers any
 *                                              OpenAI-compatible endpoint via LLM_BASE_URL)
 *   LLM_MODEL    = model id (cheap + fast; reply must come back in ~3s)
 *   LLM_API_KEY  = key (falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY)
 */

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
  /** USD for a call, used for the `llm_usage` table. */
  costUsd(inputTokens: number, outputTokens: number): number;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = "LlmError";
  }
}

// USD per 1M tokens (input, output). Unknown models use LLM_COST_* env or 0.
const PRICES: Array<[RegExp, number, number]> = [
  [/haiku-4-5|haiku/i, 1, 5],
  [/sonnet/i, 3, 15],
  [/opus/i, 5, 25],
  [/gpt-4o-mini|gpt-4\.1-mini|gpt-5-mini/i, 0.15, 0.6],
  [/gpt-4o|gpt-4\.1/i, 2.5, 10],
];

export function priceFor(model: string): [number, number] {
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new LlmError(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw new LlmError(error instanceof Error ? error.message : "LLM network error");
  } finally {
    clearTimeout(timer);
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  constructor(
    private apiKey: string,
    readonly model: string,
    private baseUrl = "https://api.anthropic.com"
  ) {}

  costUsd(i: number, o: number) {
    return calcCostUsd(this.model, i, o);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
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
      req.timeoutMs ?? 12_000
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LlmError(`Anthropic ${response.status}: ${body.slice(0, 300)}`, response.status);
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
    private baseUrl = "https://api.openai.com/v1"
  ) {}

  costUsd(i: number, o: number) {
    return calcCostUsd(this.model, i, o);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
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

    const response = await fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: req.temperature ?? 0.4,
          max_tokens: req.maxTokens ?? 600,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: { name: req.schemaName, schema: req.schema },
          },
        }),
      },
      req.timeoutMs ?? 12_000
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new LlmError(`OpenAI ${response.status}: ${body.slice(0, 300)}`, response.status);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      json: data.choices?.[0]?.message?.content ?? null,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}

let override: LLMProvider | null | undefined;

/** Tests (and the sandbox) can inject a provider. Pass undefined to reset. */
export function setLlmProviderForTests(provider: LLMProvider | null | undefined) {
  override = provider;
}

export function getLlmProvider(): LLMProvider | null {
  if (override !== undefined) return override;
  const kind = (process.env.LLM_PROVIDER ?? "").toLowerCase();
  const model = process.env.LLM_MODEL;

  if (kind === "openai") {
    const key = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!key) return null;
    return new OpenAICompatibleProvider(
      key,
      model ?? "gpt-4o-mini",
      process.env.LLM_BASE_URL ?? undefined
    );
  }

  const key = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (kind === "anthropic" || (!kind && key)) {
    if (!key) return null;
    return new AnthropicProvider(
      key,
      model ?? "claude-haiku-4-5-20251001",
      process.env.LLM_BASE_URL ?? undefined
    );
  }
  return null;
}
