/**
 * The v2 structured answer (design "Turn (v2)"): the model writes the reply
 * and extracts fields, cites the knowledge-base lines it used and reports
 * its confidence. Code decides everything else (lib/javobai/turn.ts).
 *
 * Parsing is forgiving the same way production's is (lib/assistant/llm-output):
 * a JSON object, a JSON string, or text with JSON inside a code fence.
 */

import { z } from "zod";
import { INTENTS, type JavobAiIntent } from "./config";

const nullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (typeof v === "string" && v.trim() ? v.trim() : null));

/** Knowledge-base line ids: P3 (product), F7 (FAQ), K2 (entry), B1 (profile fact). */
export const FACT_ID = /^[PFKB]\d{1,3}$/;

export const javobAiOutputSchema = z.object({
  reply: z.string().default(""),
  intent: z
    .string()
    .transform((v): JavobAiIntent => ((INTENTS as readonly string[]).includes(v) ? (v as JavobAiIntent) : "other"))
    .default("other"),
  confidence: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      const n = typeof v === "string" ? Number(v) : v;
      return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
    }),
  used_facts: z
    .union([z.array(z.unknown()), z.null()])
    .optional()
    .transform((v) =>
      (Array.isArray(v) ? v : [])
        .map((id) => String(id).trim().toUpperCase())
        .filter((id) => FACT_ID.test(id))
    ),
  extracted: z
    .object({
      name: nullableString,
      email: nullableString,
      product: nullableString,
      interest: nullableString,
      budget: nullableString,
      location: nullableString,
      extra_field: nullableString,
    })
    .default({ name: null, email: null, product: null, interest: null, budget: null, location: null, extra_field: null }),
  language: z.string().default("other"),
  handoff_request: z
    .object({
      needed: z.boolean().default(false),
      reason: nullableString,
    })
    .default({ needed: false, reason: null }),
  unknown_question: nullableString,
  memory_note: nullableString,
});

export type JavobAiOutput = z.infer<typeof javobAiOutputSchema>;

/** JSON Schema handed to the provider (tool input schema / response_format). */
export const JAVOBAI_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "Short reply to the customer, max 300 chars, in the customer's language and script" },
    intent: { type: "string", enum: [...INTENTS] },
    confidence: { type: "number", description: "0..1: how sure you are the reply is correct and fully backed by the knowledge base" },
    used_facts: {
      type: "array",
      items: { type: "string" },
      description: "Ids of the knowledge-base lines the reply relies on (P3, F7, K2, B1). Empty when none.",
    },
    extracted: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
        product: { type: ["string", "null"], description: "Product or service the customer wants, as named in the catalog" },
        interest: { type: ["string", "null"], description: "What exactly they need, in a few words" },
        budget: { type: ["string", "null"] },
        location: { type: ["string", "null"] },
        extra_field: { type: ["string", "null"] },
      },
      required: ["name", "email", "product", "interest", "budget", "location", "extra_field"],
    },
    language: { type: "string", enum: ["uz_latn", "uz_cyrl", "ru", "other"] },
    handoff_request: {
      type: "object",
      properties: {
        needed: { type: "boolean" },
        reason: { type: ["string", "null"], enum: ["wants_human", "complaint", "sensitive", "purchase_ready", null] },
      },
      required: ["needed", "reason"],
    },
    unknown_question: {
      type: ["string", "null"],
      description: "The customer's question when the knowledge base cannot answer it, else null",
    },
    memory_note: {
      type: ["string", "null"],
      description: "One short sentence worth remembering about this customer (Uzbek), else null",
    },
  },
  required: ["reply", "intent", "confidence", "used_facts", "extracted", "language", "handoff_request", "unknown_question", "memory_note"],
} as const;

export function parseJavobAiOutput(raw: unknown): JavobAiOutput | null {
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
  const parsed = javobAiOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
