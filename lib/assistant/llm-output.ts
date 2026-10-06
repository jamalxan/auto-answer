import { z } from "zod";

export const INTENTS = [
  "product_question",
  "price_question",
  "greeting",
  "gives_contact",
  "refuses_contact",
  "complaint",
  "spam_or_irrelevant",
  "asks_if_bot",
  "wants_human",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];

const nullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (typeof v === "string" && v.trim() ? v.trim() : null));

export const llmOutputSchema = z.object({
  reply: z.string().default(""),
  extracted: z
    .object({
      name: nullableString,
      product_interest: nullableString,
      extra_field: nullableString,
    })
    .default({ name: null, product_interest: null, extra_field: null }),
  intent: z
    .string()
    .transform((v): Intent => ((INTENTS as readonly string[]).includes(v) ? (v as Intent) : "other"))
    .default("other"),
  language: z.string().default("other"),
  summary: nullableString,
  unknown_question: nullableString,
});

export type LlmOutput = z.infer<typeof llmOutputSchema>;

/** JSON Schema handed to the provider (tool input schema / response_format). */
export const LLM_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Short reply to the customer, max 300 chars, in the customer's language" },
    extracted: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        product_interest: { type: ["string", "null"] },
        extra_field: { type: ["string", "null"] },
      },
      required: ["name", "product_interest", "extra_field"],
    },
    intent: { type: "string", enum: [...INTENTS] },
    language: { type: "string", enum: ["uz_latn", "uz_cyrl", "ru", "other"] },
    summary: { type: ["string", "null"], description: "1-2 sentences for the operator; only when handing off" },
    unknown_question: {
      type: ["string", "null"],
      description: "Customer question the company info cannot answer, else null",
    },
  },
  required: ["reply", "extracted", "intent", "language", "summary", "unknown_question"],
} as const;

/**
 * Parse whatever the model returned: a JSON object, a JSON string, or text with
 * JSON embedded in it / wrapped in a code fence. Returns null when it cannot be
 * repaired, and the caller retries once, then falls back to a template.
 */
export function parseLlmOutput(raw: unknown): LlmOutput | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    try {
      value = JSON.parse(text);
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end <= start) return null;
      try {
        value = JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  const parsed = llmOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
