/**
 * Lead scoring (TZ 24). Pure: signals are computed by CODE from what a turn
 * found (never a score from the model), each signal counts once per lead
 * cycle (the engine stores them as AiScoreEvent rows, unique per signal), and
 * the score is the plain sum. Rules and thresholds come from AiScoringConfig
 * (per workspace, optionally per account), defaulting to DEFAULT_SCORING.
 */

import type { AiTemperature } from "@/app/generated/prisma/client";
import { DEFAULT_SCORING, type ScoreRule, type ScoreThresholds } from "./config";

export interface ScoringConfig {
  rules: ScoreRule[];
  thresholds: ScoreThresholds;
  /** A score at or above this opens a handoff (null = never by score). */
  handoffAtScore: number | null;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = { ...DEFAULT_SCORING, handoffAtScore: null };

export interface ScoreEvent {
  signal: string;
  points: number;
}

/** The stored AiScoringConfig row (or null) → a usable config with defaults. */
export function readScoringConfig(
  row: { rules: unknown; thresholds: unknown; handoffAtScore: number | null } | null | undefined
): ScoringConfig {
  if (!row) return DEFAULT_SCORING_CONFIG;
  const rules = Array.isArray(row.rules)
    ? (row.rules as Array<{ signal?: unknown; points?: unknown }>)
        .filter((r) => r && typeof r.signal === "string" && Number.isFinite(Number(r.points)))
        .map((r) => ({ signal: r.signal as string, points: Math.round(Number(r.points)) }))
    : [];
  const t = (row.thresholds && typeof row.thresholds === "object" ? row.thresholds : {}) as Partial<ScoreThresholds>;
  const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    rules: rules.length ? rules : DEFAULT_SCORING.rules,
    thresholds: {
      warm: num(t.warm, DEFAULT_SCORING.thresholds.warm),
      hot: num(t.hot, DEFAULT_SCORING.thresholds.hot),
      veryHot: num(t.veryHot, DEFAULT_SCORING.thresholds.veryHot),
    },
    handoffAtScore: row.handoffAtScore ?? null,
  };
}

export function pointsFor(signal: string, rules: ScoreRule[] = DEFAULT_SCORING.rules): number {
  return rules.find((r) => r.signal === signal)?.points ?? 0;
}

/** Sum of the events, clamped to 0..100 (TZ 24's bands end at 100). */
export function computeScore(events: ScoreEvent[]): number {
  const sum = events.reduce((n, e) => n + (Number.isFinite(e.points) ? e.points : 0), 0);
  return Math.max(0, Math.min(100, Math.round(sum)));
}

export type ScoreBand = "Cold" | "Warm" | "Hot" | "Very hot";

export function bandFor(score: number, thresholds: ScoreThresholds = DEFAULT_SCORING.thresholds): ScoreBand {
  if (score >= thresholds.veryHot) return "Very hot";
  if (score >= thresholds.hot) return "Hot";
  if (score >= thresholds.warm) return "Warm";
  return "Cold";
}

/**
 * The stored temperature follows the band. CUSTOMER / LOST are set by an
 * operator (or the LOST sweep), never here; "Very hot" is a band, not a
 * temperature.
 */
export function temperatureFor(
  score: number,
  thresholds: ScoreThresholds = DEFAULT_SCORING.thresholds
): Extract<AiTemperature, "COLD" | "WARM" | "HOT"> {
  const band = bandFor(score, thresholds);
  if (band === "Hot" || band === "Very hot") return "HOT";
  if (band === "Warm") return "WARM";
  return "COLD";
}

/** "🔥 HOT 72" — the prefix of the lead summary, so Telegram / CRM show the score. */
export function scoreLabel(score: number, thresholds: ScoreThresholds = DEFAULT_SCORING.thresholds): string {
  switch (bandFor(score, thresholds)) {
    case "Very hot":
      return `🔥🔥 VERY HOT ${score}`;
    case "Hot":
      return `🔥 HOT ${score}`;
    case "Warm":
      return `🌡 WARM ${score}`;
    default:
      return `❄️ COLD ${score}`;
  }
}

export interface TurnSignalInput {
  intent: string;
  /** Fields known after this turn (merged). */
  extracted: { product?: string | null; budget?: string | null; location?: string | null; email?: string | null };
  phoneKnown: boolean;
  returningContact: boolean;
  cameFromAd: boolean;
  /** The deterministic detector (lib/javobai/price-detector.ts) fired: forces price_asked whatever the model said. */
  priceAsked?: boolean;
}

/**
 * Every signal this turn supports, with points from the rules. The caller
 * drops the ones already counted in this lead cycle.
 */
export function signalsFromTurn(input: TurnSignalInput, rules: ScoreRule[] = DEFAULT_SCORING.rules): ScoreEvent[] {
  const keys: string[] = [];
  if (input.extracted.product) keys.push("product_selected");
  if (input.intent === "price_question" || input.priceAsked) keys.push("price_asked");
  if (input.phoneKnown) keys.push("phone_provided");
  if (input.intent === "purchase_intent") keys.push("purchase_intent");
  if (input.intent === "payment_intent") keys.push("payment_intent", "purchase_intent");
  if (input.extracted.email) keys.push("email_provided");
  if (input.extracted.budget) keys.push("budget_given");
  if (input.extracted.location) keys.push("location_given");
  if (input.returningContact) keys.push("returning_contact");
  if (input.cameFromAd) keys.push("came_from_ad");
  if (input.intent === "complaint") keys.push("complaint");
  return [...new Set(keys)].map((signal) => ({ signal, points: pointsFor(signal, rules) }));
}

/** Signals not yet counted in this cycle. */
export function newSignals(candidates: ScoreEvent[], counted: Iterable<string>): ScoreEvent[] {
  const seen = new Set(counted);
  return candidates.filter((c) => !seen.has(c.signal));
}
