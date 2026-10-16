/**
 * ETAP 9.3 — referral fraud flags (pure, no database). A flagged event is not
 * rewarded until the owner approves it (program.ts reviewReferralEvent).
 *
 *   SELF_REFERRAL         referee is the referrer
 *   SAME_PHONE            both CRM contacts have a phone and it is the same
 *   BURST                 more than `burstLimitPerDay` events for one referrer in 24 hours
 *   ALREADY_KNOWN_CONTACT the referee already had events on the account before the ref event
 */

export const FRAUD_FLAGS = ["SELF_REFERRAL", "SAME_PHONE", "BURST", "ALREADY_KNOWN_CONTACT"] as const;
export type FraudFlag = (typeof FRAUD_FLAGS)[number];

export const FRAUD_FLAG_LABELS: Record<FraudFlag, string> = {
  SELF_REFERRAL: "O'zini taklif qilgan",
  SAME_PHONE: "Telefon raqami bir xil",
  BURST: "Bir kunda juda ko'p taklif",
  ALREADY_KNOWN_CONTACT: "Avvaldan tanish kontakt",
};

export interface FraudInput {
  referrerIgUserId: string;
  refereeIgUserId: string;
  referrerPhone?: string | null;
  refereePhone?: string | null;
  /** Events of this referrer in the 24 hours up to and including this one. */
  referrerEventsIn24h: number;
  burstLimitPerDay: number;
  /** The referee had events on the account before the ref event (the carrying event excluded). */
  refereeKnownBefore: boolean;
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = a?.trim();
  const y = b?.trim();
  return Boolean(x && y && x === y);
}

export function computeFraudFlags(input: FraudInput): FraudFlag[] {
  const flags: FraudFlag[] = [];
  if (input.referrerIgUserId === input.refereeIgUserId) flags.push("SELF_REFERRAL");
  if (samePhone(input.referrerPhone, input.refereePhone)) flags.push("SAME_PHONE");
  if (input.referrerEventsIn24h > input.burstLimitPerDay) flags.push("BURST");
  if (input.refereeKnownBefore) flags.push("ALREADY_KNOWN_CONTACT");
  return flags;
}

/** Stored flags as typed values (unknown strings are dropped). */
export function parseFlags(value: unknown): FraudFlag[] {
  if (!Array.isArray(value)) return [];
  return value.filter((flag): flag is FraudFlag => (FRAUD_FLAGS as readonly string[]).includes(flag as string));
}

/** Union keeping the canonical order. */
export function mergeFlags(a: readonly string[], b: readonly string[]): FraudFlag[] {
  const set = new Set([...a, ...b]);
  return FRAUD_FLAGS.filter((flag) => set.has(flag));
}

/** A flagged event waits for the owner until it was reviewed. */
export function isBlocked(event: { fraudFlags: readonly string[]; reviewedAt: Date | null | undefined }): boolean {
  return event.fraudFlags.length > 0 && !event.reviewedAt;
}
