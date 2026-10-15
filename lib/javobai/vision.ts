/**
 * JavobAI ETAP 4.3 — a customer photo → description + catalog match (TZ §26:
 * "User uploads product image → Vision AI → Business catalog match → Answer").
 *
 * One `LLMProvider.complete` call with the image attached as a data URI
 * (provider.ts puts images on the last user message for both the Anthropic
 * and the OpenAI-compatible / Gemini paths). The model sees at most
 * `MAX_CATALOG_ITEMS` product names and returns a strict JSON object; code
 * then decides (`decideImageOutcome`) whether the engine answers from the
 * catalog, asks the customer a question, or hands off.
 *
 * Image bytes never reach a log or the result object; only the description
 * is kept (the engine may store that in the turn as a system note).
 */

import { z } from "zod";
import type { LLMProvider, LlmResponse } from "@/lib/assistant/llm/provider";
import type { Lang } from "@/lib/assistant/language";

export const MAX_CATALOG_ITEMS = 60;
export const VISION_DEFAULT_THRESHOLD = 0.6;
/** Below this the model did not really understand the picture. */
export const VISION_UNREADABLE = 0.2;
const MAX_NAME_CHARS = 80;
const MAX_NOTE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_QUESTION_CHARS = 300;

export interface CatalogItem {
  id: string;
  name: string;
  /** Short hint shown to the model (variant, colour, category). Never a price. */
  note?: string | null;
}

export interface VisionInput {
  buffer: Buffer;
  /** Sniffed: image/jpeg | image/png | image/webp. */
  mime: string;
  catalog: readonly CatalogItem[];
  provider: LLMProvider;
  /** Language for `question_for_customer`; defaults to Uzbek Latin. */
  lang?: Lang;
  /** What the customer wrote with the photo, if anything. */
  customerText?: string;
  timeoutMs?: number;
}

export interface VisionMatch {
  id: string;
  name: string;
}

export interface VisionResult {
  description: string;
  matches: VisionMatch[];
  confidence: number;
  question: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  /** The catalog was longer than MAX_CATALOG_ITEMS; only the first ones were shown. */
  catalogTruncated: boolean;
}

export class VisionError extends Error {
  constructor(
    public code: "no_provider" | "unparseable" | "llm",
    detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "VisionError";
  }
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const clamp01 = (value: unknown) => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

export const visionOutputSchema = z.object({
  description: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === "string" ? v.trim().slice(0, MAX_DESCRIPTION_CHARS) : "")),
  matched_product_ids: z
    .union([z.array(z.unknown()), z.null()])
    .optional()
    .transform((v) => (Array.isArray(v) ? v.map((id) => String(id).trim()).filter(Boolean) : [])),
  confidence: z.union([z.number(), z.string(), z.null()]).optional().transform(clamp01),
  question_for_customer: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      const text = typeof v === "string" ? v.trim().slice(0, MAX_QUESTION_CHARS) : "";
      return text || null;
    }),
});

export type VisionOutput = z.infer<typeof visionOutputSchema>;

/** JSON Schema handed to the provider (Anthropic tool input / OpenAI json_schema). */
export const VISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string", description: "What the photo shows, 1-2 sentences, no prices." },
    matched_product_ids: {
      type: "array",
      items: { type: "string" },
      description: "Ids of catalog items that are the same product as in the photo; empty when none.",
    },
    confidence: { type: "number", description: "0..1 — how sure the match (or the no-match) is." },
    question_for_customer: {
      type: ["string", "null"],
      description: "One short clarifying question when the photo alone is not enough; null otherwise.",
    },
  },
  required: ["description", "matched_product_ids", "confidence", "question_for_customer"],
} as const;

// ─── Prompt ───────────────────────────────────────────────────────────────────

const QUESTION_LANG: Record<Lang, string> = {
  uz_latn: "Uzbek in Latin script",
  uz_cyrl: "Uzbek in Cyrillic script",
  ru: "Russian",
};

const sanitizeLine = (value: string, max: number) =>
  value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The catalog lines the model sees: `id | name — note`. Capped at MAX_CATALOG_ITEMS. */
export function catalogForPrompt(catalog: readonly CatalogItem[]): { lines: string[]; truncated: boolean } {
  const items = catalog.filter((c) => c && c.id && c.name).slice(0, MAX_CATALOG_ITEMS);
  const lines = items.map((c) => {
    const name = sanitizeLine(c.name, MAX_NAME_CHARS);
    const note = c.note ? sanitizeLine(c.note, MAX_NOTE_CHARS) : "";
    return note ? `${c.id} | ${name} — ${note}` : `${c.id} | ${name}`;
  });
  return { lines, truncated: catalog.length > MAX_CATALOG_ITEMS };
}

export function buildVisionPrompt(input: {
  catalog: readonly CatalogItem[];
  lang?: Lang;
  customerText?: string;
}): { system: string; user: string; truncated: boolean } {
  const { lines, truncated } = catalogForPrompt(input.catalog);
  const lang = QUESTION_LANG[input.lang ?? "uz_latn"];
  const system = [
    "You look at a photo a customer sent to an Instagram shop and match it against the shop's catalog.",
    "Rules: describe only what is visible; never guess prices or availability; never invent products.",
    "A product matches only when it is clearly the same item (not merely the same category).",
    "When the photo shows a product that is not in the catalog, return an empty matched_product_ids list.",
    `Write question_for_customer in ${lang}, one short sentence, only when a question would help; otherwise null.`,
    "Return only the JSON object.",
    "",
    lines.length ? "Catalog (id | name — note):" : "Catalog: (empty — no products to match)",
    ...lines,
  ].join("\n");
  const user = [
    "Photo attached.",
    input.customerText?.trim() ? `Customer wrote: "${sanitizeLine(input.customerText, 300)}"` : "The customer sent no text.",
    "Describe the photo and match it against the catalog.",
  ].join("\n");
  return { system, user, truncated };
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function extractJson(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Model output (object, JSON string, fenced JSON) → parsed, with
 * `matched_product_ids` restricted to ids that exist in the catalog.
 */
export function parseVisionOutput(raw: unknown, catalog: readonly CatalogItem[]): VisionOutput | null {
  const json = extractJson(raw);
  if (!json) return null;
  const parsed = visionOutputSchema.safeParse(json);
  if (!parsed.success) return null;
  const known = new Map(catalog.map((c) => [c.id, c] as const));
  const ids = [...new Set(parsed.data.matched_product_ids)].filter((id) => known.has(id));
  return { ...parsed.data, matched_product_ids: ids };
}

// ─── Call ─────────────────────────────────────────────────────────────────────

export async function describeAndMatchImage(input: VisionInput): Promise<VisionResult> {
  if (!input.provider) throw new VisionError("no_provider");
  const prompt = buildVisionPrompt({ catalog: input.catalog, lang: input.lang, customerText: input.customerText });

  let response: LlmResponse;
  try {
    response = await input.provider.complete({
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      schema: VISION_JSON_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "javobai_vision",
      temperature: 0.1,
      maxTokens: 400,
      timeoutMs: input.timeoutMs ?? 20_000,
      images: [{ mediaType: input.mime, base64: input.buffer.toString("base64") }],
    });
  } catch (error) {
    // Re-wrap so a provider error message can never carry request bytes upward.
    throw new VisionError("llm", error instanceof Error ? error.message.slice(0, 300) : "llm error");
  }

  const parsed = parseVisionOutput(response.json, input.catalog);
  if (!parsed) throw new VisionError("unparseable");

  const byId = new Map(input.catalog.map((c) => [c.id, c] as const));
  return {
    description: parsed.description,
    matches: parsed.matched_product_ids.map((id) => ({ id, name: byId.get(id)!.name })),
    confidence: parsed.confidence,
    question: parsed.question_for_customer,
    model: response.model,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    latencyMs: response.latencyMs,
    costUsd: input.provider.costUsd(response.inputTokens, response.outputTokens, response.model),
    catalogTruncated: prompt.truncated,
  };
}

// ─── Decision ─────────────────────────────────────────────────────────────────

export type ImageOutcome = "answer_from_catalog" | "ask" | "handoff";

/**
 * Pure. `answer_from_catalog` when at least one match is at or above the
 * threshold; `ask` when the model understood the picture (a question, a
 * weak match or a usable description); `handoff` when it did not.
 */
export function decideImageOutcome(
  result: Pick<VisionResult, "matches" | "confidence"> & Partial<Pick<VisionResult, "question" | "description">>,
  threshold: number = VISION_DEFAULT_THRESHOLD
): ImageOutcome {
  const confidence = clamp01(result.confidence);
  if (result.matches.length > 0 && confidence >= threshold) return "answer_from_catalog";
  if (result.question) return "ask";
  if (result.matches.length > 0) return "ask";
  if (result.description?.trim() && confidence >= VISION_UNREADABLE) return "ask";
  return "handoff";
}

// ─── Usage row ────────────────────────────────────────────────────────────────

/** Same shape as `RecordJavobAiUsageInput` (lib/javobai/usage.ts), kind "javobai_vision". */
export interface VisionUsageRecord {
  workspaceId: string;
  conversationId: string | null;
  kind: "javobai_vision";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
}

export function visionUsageRecord(
  result: Pick<VisionResult, "model" | "inputTokens" | "outputTokens" | "costUsd" | "latencyMs">,
  scope: { workspaceId: string; conversationId?: string | null },
  ok = true
): VisionUsageRecord {
  return {
    workspaceId: scope.workspaceId,
    conversationId: scope.conversationId ?? null,
    kind: "javobai_vision",
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    ok,
  };
}

/** The one-line system note the engine feeds into the turn (no bytes, no url). */
export function visionSystemNote(result: Pick<VisionResult, "description" | "matches" | "confidence">): string {
  const matches = result.matches.length
    ? `Mos mahsulotlar: ${result.matches.map((m) => `${m.name} (${m.id})`).join(", ")}`
    : "Katalogda mos mahsulot topilmadi";
  return `[Mijoz rasm yubordi] Tavsif: ${result.description || "—"}. ${matches}. Ishonch: ${result.confidence.toFixed(2)}.`;
}
