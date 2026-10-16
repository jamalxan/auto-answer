/**
 * ETAP 5.4 — broadcast policy engine (TZ 33, Meta rules as checked on
 * 2026-10-15).
 *
 * A business may message a person only inside the 24-hour window after that
 * person's last message or button tap. There is no messaging-tag support in
 * the app, so anyone outside the window is NOT eligible and is shown with
 * the reason — never silently dropped, never forced.
 *
 * `evaluateRecipient` applies the rules in the documented order and returns
 * the snapshot the DB layer stores on `CrmBroadcastRecipient`:
 *
 *   1. workspace not suspended        → SUSPENDED
 *   2. token healthy                  → TOKEN_BROKEN
 *   3. the person has written         → NO_INBOUND
 *   4. window open (24h − 5 min)      → WINDOW_CLOSED
 *   5. not opted out                  → OPTED_OUT
 *   6. frequency cap (default 24h)    → FREQUENCY_CAP
 *   7. not in an active handoff       → OPERATOR_ACTIVE  (owner decision 2)
 *   8. not already in this broadcast  → DUPLICATE
 *
 * The window rule has the same semantics as lib/triggers/followups
 * `isWindowOpen`; it is implemented here so this module stays free of the
 * trigger engine's database imports (the test asserts both agree).
 *
 * Pure: no database.
 */

import { containsWords, normalizeForMatch } from "@/lib/triggers/keywords";
import { INELIGIBILITY_LABELS, INELIGIBILITY_REASONS, type CrmHandoffState, type IneligibilityReason } from "./types";

// ─── Window ───────────────────────────────────────────────────────────────────

export const MESSAGING_WINDOW_MS = 24 * 3600_000;
/** A send this close to the window's end may arrive after it closed. */
export const WINDOW_SAFETY_MS = 5 * 60_000;

/** True while a message to the person is still inside Meta's 24-hour window (with margin). */
export function isBroadcastWindowOpen(lastInboundAt: Date | null | undefined, now: Date): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < MESSAGING_WINDOW_MS - WINDOW_SAFETY_MS;
}

/** When the window closes for sends (anchor + 24h − margin); null without an anchor. */
export function windowClosesAt(lastInboundAt: Date | null | undefined): Date | null {
  if (!lastInboundAt) return null;
  return new Date(lastInboundAt.getTime() + MESSAGING_WINDOW_MS - WINDOW_SAFETY_MS);
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

export interface RecipientPolicyInput {
  now: Date;
  workspaceSuspended: boolean;
  /** InstagramAccount.tokenStatus ("ACTIVE" is healthy; anything else is not). */
  tokenStatus: string | null | undefined;
  lastInboundAt: Date | null | undefined;
  optedOutAt: Date | null | undefined;
  /** Last broadcast this person received (any broadcast of the workspace). */
  lastBroadcastSentAt: Date | null | undefined;
  /** 0 disables the cap. */
  frequencyCapHours: number;
  handoffState?: CrmHandoffState | string | null;
  /** Already a recipient row of this broadcast (same contact twice in the audience). */
  alreadyInBroadcast: boolean;
}

/** JSON-friendly copy of what was checked, stored with the recipient. */
export interface EligibilitySnapshot {
  evaluatedAt: string;
  workspaceSuspended: boolean;
  tokenStatus: string | null;
  lastInboundAt: string | null;
  windowOpen: boolean;
  windowClosesAt: string | null;
  optedOutAt: string | null;
  lastBroadcastSentAt: string | null;
  frequencyCapHours: number;
  handoffState: string | null;
  alreadyInBroadcast: boolean;
}

export interface RecipientEvaluation {
  eligible: boolean;
  reason?: IneligibilityReason;
  /** Uzbek label of `reason`, for the eligibility preview. */
  label?: string;
  snapshot: EligibilitySnapshot;
}

const ACTIVE_HANDOFF: ReadonlySet<string> = new Set<string>(["HANDOFF_PENDING", "OPERATOR_ACTIVE"]);

export function isActiveHandoff(state: string | null | undefined): boolean {
  return Boolean(state && ACTIVE_HANDOFF.has(state));
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Decides, in the documented order, whether one recipient may receive the broadcast now. */
export function evaluateRecipient(input: RecipientPolicyInput): RecipientEvaluation {
  const { now } = input;
  const lastInboundAt = input.lastInboundAt ?? null;
  const windowOpen = isBroadcastWindowOpen(lastInboundAt, now);
  const snapshot: EligibilitySnapshot = {
    evaluatedAt: now.toISOString(),
    workspaceSuspended: input.workspaceSuspended,
    tokenStatus: input.tokenStatus ?? null,
    lastInboundAt: iso(lastInboundAt),
    windowOpen,
    windowClosesAt: iso(windowClosesAt(lastInboundAt)),
    optedOutAt: iso(input.optedOutAt),
    lastBroadcastSentAt: iso(input.lastBroadcastSentAt),
    frequencyCapHours: input.frequencyCapHours,
    handoffState: input.handoffState ?? null,
    alreadyInBroadcast: input.alreadyInBroadcast,
  };
  const reason = findReason(input, windowOpen);
  return reason
    ? { eligible: false, reason, label: INELIGIBILITY_LABELS[reason], snapshot }
    : { eligible: true, snapshot };
}

function findReason(input: RecipientPolicyInput, windowOpen: boolean): IneligibilityReason | null {
  if (input.workspaceSuspended) return "SUSPENDED";
  if (input.tokenStatus !== "ACTIVE") return "TOKEN_BROKEN";
  if (!input.lastInboundAt) return "NO_INBOUND";
  if (!windowOpen) return "WINDOW_CLOSED";
  if (input.optedOutAt) return "OPTED_OUT";
  if (isUnderFrequencyCap(input.lastBroadcastSentAt, input.frequencyCapHours, input.now)) return "FREQUENCY_CAP";
  if (isActiveHandoff(input.handoffState)) return "OPERATOR_ACTIVE";
  if (input.alreadyInBroadcast) return "DUPLICATE";
  return null;
}

/** True when the person got a broadcast less than `capHours` ago (0 = no cap). */
export function isUnderFrequencyCap(lastBroadcastSentAt: Date | null | undefined, capHours: number, now: Date): boolean {
  if (!lastBroadcastSentAt || !(capHours > 0)) return false;
  return now.getTime() - lastBroadcastSentAt.getTime() < capHours * 3600_000;
}

export interface EligibilitySummary {
  total: number;
  eligible: number;
  ineligible: number;
  byReason: Record<IneligibilityReason, number>;
}

/** Counts for the audience preview: "3 ta yuboriladi, 2 ta: 24 soatlik oyna yopilgan". */
export function summarizeEligibility(results: Array<Pick<RecipientEvaluation, "eligible" | "reason">>): EligibilitySummary {
  const byReason = Object.fromEntries(INELIGIBILITY_REASONS.map((reason) => [reason, 0])) as Record<IneligibilityReason, number>;
  let eligible = 0;
  for (const result of results) {
    if (result.eligible) eligible++;
    else if (result.reason) byReason[result.reason]++;
  }
  return { total: results.length, eligible, ineligible: results.length - eligible, byReason };
}

// ─── Opt-out ──────────────────────────────────────────────────────────────────

/** Any of these as a whole word (after normalizeForMatch) opts the person out. */
export const OPT_OUT_WORDS: string[] = [
  "stop",
  "стоп",
  "to'xtat",
  "to'xtating",
  "тўхтат",
  "тўхтатинг",
  "отпишите",
  "отписаться",
  "отписать",
  "unsubscribe",
];

let normalizedOptOut: string[] | null = null;

/** True when the message is an opt-out request ("STOP", "to'xtating", "Отпишите меня"). */
export function isOptOutMessage(text: string | null | undefined): boolean {
  const normalized = normalizeForMatch(text ?? "");
  if (!normalized) return false;
  if (!normalizedOptOut) {
    normalizedOptOut = Array.from(new Set(OPT_OUT_WORDS.map(normalizeForMatch).filter(Boolean)));
  }
  return normalizedOptOut.some((word) => containsWords(normalized, word));
}

// ─── Batching ─────────────────────────────────────────────────────────────────

/**
 * How many recipients one delivery tick may send so that `throttlePerHour`
 * holds: floor(throttle × interval / 60), at least 1 while the throttle is
 * positive (100/h at 5-minute ticks → 8 per tick). 0 when the throttle is 0.
 */
export function batchSize(throttlePerHour: number, intervalMinutes = 5): number {
  if (!(throttlePerHour > 0) || !(intervalMinutes > 0)) return 0;
  return Math.max(1, Math.floor((throttlePerHour * intervalMinutes) / 60));
}
