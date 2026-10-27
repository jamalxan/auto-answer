/**
 * Trust ladder (audit 2026-10-26, "kuzatish → copilot → avto"). Pure rules:
 * which intent may be answered how, when an intent is ready for AUTO, and
 * when an AUTO intent falls back to COPILOT. The runtime (runtime.ts), the
 * judge (judge.ts) and the dev UI all read these.
 *
 *   OBSERVE — the AI drafts, nothing is sent; the operator answers and the
 *             draft is judged against what the operator wrote.
 *   COPILOT — the draft waits in the inbox / Telegram; one tap sends it,
 *             an edit is a training signal.
 *   AUTO    — sent; only after the readiness bar below and the owner's switch.
 *
 * The ladder is opt-in per account (config `ladderEnabled`): without it
 * JavobAI LIVE behaves exactly as before (every model reply is sent).
 */

import type { JavobAiIntent } from "./config";

export type LadderMode = "OBSERVE" | "COPILOT" | "AUTO";
export type LadderDecision = "send" | "draft" | "observe";

/** Readiness bar (starting values from the audit; calibrated later). */
export const LADDER_MIN_SAMPLES = 50;
export const LADDER_MIN_MATCH_RATE = 0.9;
/** Critical errors are counted over this many most recent judged samples. */
export const LADDER_CRITICAL_WINDOW = 100;
/** AUTO falls back when complaints follow more than this share of recent auto replies. */
export const LADDER_COMPLAINT_RATE = 0.1;
export const LADDER_COMPLAINT_WINDOW = 50;

export type FactNeed = "price" | "product" | "delivery" | "business" | null;

export interface IntentRule {
  label: string;
  /** Never answered by the model on its own: always a manager (doc: complaint, refund, payment problem). */
  neverAuto: boolean;
  /** An approved, unexpired fact of this kind must exist before AUTO. */
  needs: FactNeed;
  /** Doc's "first to go auto" group: shown first in the UI. */
  early: boolean;
}

export const INTENT_RULES: Record<JavobAiIntent, IntentRule> = {
  greeting: { label: "Salomlashish", neverAuto: false, needs: null, early: true },
  business_info: { label: "Ish vaqti, manzil, aloqa", neverAuto: false, needs: "business", early: true },
  product_question: { label: "Mahsulot / mavjudlik", neverAuto: false, needs: "product", early: false },
  price_question: { label: "Narx", neverAuto: false, needs: "price", early: false },
  delivery_question: { label: "Yetkazib berish", neverAuto: false, needs: "delivery", early: false },
  purchase_intent: { label: "Buyurtma", neverAuto: false, needs: null, early: false },
  payment_intent: { label: "To'lov", neverAuto: false, needs: null, early: false },
  gives_contact: { label: "Raqam berdi", neverAuto: false, needs: null, early: false },
  refuses_contact: { label: "Raqam bermadi", neverAuto: false, needs: null, early: false },
  asks_if_bot: { label: "\"Botmisan?\"", neverAuto: false, needs: null, early: true },
  spam_or_irrelevant: { label: "Spam / boshqa mavzu", neverAuto: false, needs: null, early: false },
  other: { label: "Noma'lum savol", neverAuto: false, needs: null, early: false },
  complaint: { label: "Shikoyat", neverAuto: true, needs: null, early: false },
  wants_human: { label: "Odam so'radi", neverAuto: true, needs: null, early: false },
  sensitive: { label: "Nozik vaziyat", neverAuto: true, needs: null, early: false },
};

export function ruleFor(intent: string | null | undefined): IntentRule {
  return INTENT_RULES[(intent ?? "other") as JavobAiIntent] ?? INTENT_RULES.other;
}

// ─── Decision at send time ────────────────────────────────────────────────────

export interface LadderInput {
  ladderEnabled: boolean;
  intent: string | null;
  /** The account's policy for this intent (no row = OBSERVE). */
  mode: LadderMode | null;
  /** A fixed text decided by code (handoff closing, "I don't know", a qualification question): not a model claim. */
  usedTemplate: boolean;
}

export function decideLadder(input: LadderInput): LadderDecision {
  if (!input.ladderEnabled) return "send";
  if (input.usedTemplate) return "send";
  let mode: LadderMode = input.mode ?? "OBSERVE";
  if (ruleFor(input.intent).neverAuto && mode === "AUTO") mode = "COPILOT";
  return mode === "AUTO" ? "send" : mode === "COPILOT" ? "draft" : "observe";
}

// ─── Facts the intents need ───────────────────────────────────────────────────

export interface FactCoverage {
  price: boolean;
  product: boolean;
  delivery: boolean;
  business: boolean;
}

export function factCoverage(input: {
  products: Array<{ price: number | null }>;
  faqs?: unknown[];
  delivery: string | null;
  address: string | null;
  workingHours: string | null;
  /** Verified, active, unexpired entries only. */
  entries: Array<{ kind: string }>;
}): FactCoverage {
  const has = (kind: string) => input.entries.some((e) => e.kind === kind);
  return {
    price: input.products.some((p) => p.price !== null && p.price !== undefined) || has("PRICE"),
    product: input.products.length > 0 || (input.faqs?.length ?? 0) > 0,
    delivery: Boolean(input.delivery?.trim()) || has("DELIVERY"),
    business: Boolean(input.address?.trim() || input.workingHours?.trim()) || has("HOURS") || has("BRANCH") || has("CONTACT"),
  };
}

// ─── Readiness ────────────────────────────────────────────────────────────────

export interface LadderSample {
  judgeMatch: boolean | null;
  critical: string | null;
  createdAt: Date;
}

export interface Readiness {
  samples: number;
  judged: number;
  matched: number;
  matchRate: number | null;
  criticalRecent: number;
  hasFact: boolean;
  ready: boolean;
  /** Why not (Uzbek, for the UI); empty when ready. */
  missing: string[];
}

export function isCritical(critical: string | null | undefined): boolean {
  return Boolean(critical && critical !== "none");
}

export function readiness(intent: string, samples: LadderSample[], coverage: FactCoverage): Readiness {
  const rule = ruleFor(intent);
  const judged = samples.filter((s) => s.judgeMatch !== null).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const matched = judged.filter((s) => s.judgeMatch).length;
  const matchRate = judged.length ? matched / judged.length : null;
  const criticalRecent = judged.slice(0, LADDER_CRITICAL_WINDOW).filter((s) => isCritical(s.critical)).length;
  const hasFact = rule.needs === null ? true : coverage[rule.needs];
  const missing: string[] = [];
  if (rule.neverAuto) missing.push("Bu tur hech qachon avtomatik javob olmaydi — doim menejer");
  if (judged.length < LADDER_MIN_SAMPLES) missing.push(`Baholangan namunalar: ${judged.length}/${LADDER_MIN_SAMPLES}`);
  if (matchRate !== null && matchRate < LADDER_MIN_MATCH_RATE) missing.push(`Operator javobiga moslik ${Math.round(matchRate * 100)}% (kerak ≥ ${Math.round(LADDER_MIN_MATCH_RATE * 100)}%)`);
  if (criticalRecent > 0) missing.push(`Oxirgi ${LADDER_CRITICAL_WINDOW} ta ichida ${criticalRecent} ta jiddiy xato`);
  if (!hasFact) missing.push("Tasdiqlangan fakt yo'q (bilim bazasiga qo'shing)");
  return { samples: samples.length, judged: judged.length, matched, matchRate, criticalRecent, hasFact, ready: missing.length === 0, missing };
}

/** Which modes the owner may switch to right now. */
export function allowedModes(intent: string, r: Readiness): LadderMode[] {
  return r.ready && !ruleFor(intent).neverAuto ? ["OBSERVE", "COPILOT", "AUTO"] : ["OBSERVE", "COPILOT"];
}

// ─── Demotion (AUTO → COPILOT) ────────────────────────────────────────────────

export type DemoteReason = "critical_error" | "fact_expired" | "complaints" | "operator_correction";

export const DEMOTE_REASON_TEXT: Record<DemoteReason, string> = {
  critical_error: "Jiddiy xato (noto'g'ri narx, fakt yoki va'da)",
  fact_expired: "Kerakli fakt muddati tugadi",
  complaints: "Avto javoblardan keyin shikoyatlar ko'paydi",
  operator_correction: "Operator avto javobni tuzatdi",
};

export function complaintRateTooHigh(autoReplies: number, complaintsAfter: number): boolean {
  return autoReplies >= 10 && complaintsAfter / autoReplies > LADDER_COMPLAINT_RATE;
}
