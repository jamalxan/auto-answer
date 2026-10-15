/**
 * JavobAI (ETAP 4) — per-account knobs, the scoring defaults (TZ 24), the
 * intent and handoff-reason vocabularies and the kill switch. Pure: no
 * database, no Instagram; shared by the engine, the sandbox and the dev UI.
 *
 * `JavobAiAccount.config` is a JSON blob validated by `javobAiConfigSchema`;
 * every field has a default so an empty `{}` (a freshly switched-on account)
 * behaves sensibly. `JAVOBAI_DISABLED=1` forces every account to production.
 */

import { z } from "zod";

export const QUALIFICATION_FIELDS = ["product", "budget", "location"] as const;
export type QualificationField = (typeof QUALIFICATION_FIELDS)[number];

export const javobAiConfigSchema = z.object({
  /** Below this the model's answer to a factual question is treated as unknown. */
  confidenceThreshold: z.number().min(0.3).max(0.9).default(0.55),
  /** Consecutive unknown answers before the conversation goes to a manager. */
  unknownStreakForHandoff: z.number().int().min(1).max(5).default(2),
  /** What the agent asks before the phone, in this order. */
  qualificationQuestions: z.array(z.enum(QUALIFICATION_FIELDS)).default(["product", "budget"]),
  /** AI replies per lead cycle; reaching it hands the thread to a manager. */
  maxTurns: z.number().int().min(4).max(30).default(12),
  /** The agent asks for the phone once the lead is at least this warm. */
  askPhoneAtTemperature: z.enum(["WARM", "HOT"]).default("WARM"),
  /** Short grounded replies still allowed while a handoff is pending. */
  postHandoffReplies: z.number().int().min(0).max(3).default(2),
  /** An operator silent for this long closes the handoff; the AI may resume. */
  resumeAfterCloseHours: z.number().int().min(1).max(168).default(24),
  /**
   * Leads of this account are marked "🧪 TEST" in the summary (owner
   * decision 3: the tenant's real Telegram / CRM get them). On by default
   * while the module lives in the developer area.
   */
  isTest: z.boolean().default(true),
});

export type JavobAiConfig = z.infer<typeof javobAiConfigSchema>;

export const DEFAULT_JAVOBAI_CONFIG: JavobAiConfig = javobAiConfigSchema.parse({});

/** Stored JSON → config with defaults; invalid or missing fields fall back. */
export function readJavobAiConfig(value: unknown): JavobAiConfig {
  const parsed = javobAiConfigSchema.safeParse(value && typeof value === "object" ? value : {});
  if (parsed.success) return parsed.data;
  // Keep the valid fields, default the rest.
  const partial: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    const shape = javobAiConfigSchema.shape[key as keyof JavobAiConfig];
    if (shape && shape.safeParse(field).success) partial[key] = field;
  }
  return javobAiConfigSchema.parse(partial);
}

// ─── Scoring (TZ 24) ──────────────────────────────────────────────────────────

export interface ScoreSignal {
  key: string;
  /** Shown in the dev UI and the lead summary (Uzbek). */
  label: string;
  defaultPoints: number;
}

export const SCORE_SIGNALS: ScoreSignal[] = [
  { key: "product_selected", label: "Mahsulot tanladi", defaultPoints: 10 },
  { key: "price_asked", label: "Narx so'radi", defaultPoints: 15 },
  { key: "phone_provided", label: "Telefon raqam berdi", defaultPoints: 20 },
  { key: "purchase_intent", label: "Sotib olish niyati", defaultPoints: 25 },
  { key: "payment_intent", label: "To'lov niyati", defaultPoints: 30 },
  { key: "email_provided", label: "Email berdi", defaultPoints: 5 },
  { key: "budget_given", label: "Byudjet aytdi", defaultPoints: 10 },
  { key: "location_given", label: "Manzil / hudud aytdi", defaultPoints: 5 },
  { key: "returning_contact", label: "Qaytgan mijoz", defaultPoints: 5 },
  { key: "came_from_ad", label: "Reklamadan keldi", defaultPoints: 5 },
  { key: "complaint", label: "Shikoyat", defaultPoints: -20 },
];

export interface ScoreRule {
  signal: string;
  points: number;
}

export interface ScoreThresholds {
  warm: number;
  hot: number;
  veryHot: number;
}

export const DEFAULT_SCORING: { rules: ScoreRule[]; thresholds: ScoreThresholds } = {
  rules: SCORE_SIGNALS.map((s) => ({ signal: s.key, points: s.defaultPoints })),
  thresholds: { warm: 30, hot: 60, veryHot: 80 },
};

// ─── Intents ──────────────────────────────────────────────────────────────────

/** Production's intents plus the three the sales agent needs. */
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
  "purchase_intent",
  "payment_intent",
  "sensitive",
  "other",
] as const;
export type JavobAiIntent = (typeof INTENTS)[number];

/** Intents whose answer must cite the knowledge base (grounding rule). */
export const FACTUAL_INTENTS: readonly JavobAiIntent[] = ["product_question", "price_question"];

// ─── Handoff reasons (TZ 25) ──────────────────────────────────────────────────

export const HANDOFF_REASONS = {
  wants_human: "Mijoz operator so'radi",
  complaint: "Shikoyat",
  sensitive: "Nozik vaziyat",
  unknown_streak: "AI javob topa olmadi",
  purchase_ready: "Sotib olishga tayyor",
  phone_captured: "Telefon raqami olindi",
  score: "Lead bali yuqori",
  rule: "Biznes qoidasi",
  max_turns: "Suhbat limiti tugadi",
  trigger_button: "Trigger tugmasi",
  budget: "AI byudjeti tugadi",
} as const;
export type HandoffReason = keyof typeof HANDOFF_REASONS;

export function handoffReasonLabel(reason: string): string {
  return (HANDOFF_REASONS as Record<string, string>)[reason] ?? reason;
}

// ─── Environment ──────────────────────────────────────────────────────────────

/** `JAVOBAI_DISABLED=1` is the kill switch: every account is OFF, no worker. */
export function isJavobAiEnabled(): boolean {
  const flag = (process.env.JAVOBAI_DISABLED ?? "").trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}

/** Model for JavobAI turns: JAVOBAI_MODEL, else production's LLM_MODEL. */
export function javobAiModel(): string | undefined {
  return process.env.JAVOBAI_MODEL?.trim() || process.env.LLM_MODEL?.trim() || undefined;
}

/** Optional stronger model (vision / voice in 4.3); falls back to the turn model. */
export function javobAiSmartModel(): string | undefined {
  return process.env.JAVOBAI_MODEL_SMART?.trim() || javobAiModel();
}
