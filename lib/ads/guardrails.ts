/**
 * Ads guardrails (audit 2026-10-26, "Himoya chegaralari"), pure so they are
 * tested without Meta:
 *
 *   approve   only a workspace OWNER; all three caps set; the new daily
 *             budget plus every live one fits the daily cap; this month's
 *             spend plus what the live and the new campaign can still spend
 *             this month fits the monthly cap; 1–30 days; ≥ the minimum
 *   watch     today's spend ≥ daily cap → pause everything; month ≥ monthly
 *             cap → pause everything; a campaign whose spend reached 2× the
 *             CPL limit with no result, or whose CPL is above the limit, is
 *             paused. Pausing needs nobody's approval; resuming does.
 */

export const MAX_DURATION_DAYS = 30;
/** Meta's practical floor is about 1 USD a day. */
export const MIN_DAILY_BUDGET_MAJOR = 1;
/** CPL is judged only after this many CPLs were spent. */
export const CPL_JUDGE_AFTER = 2;

export interface Caps {
  dailyCapMinor: number | null;
  monthlyCapMinor: number | null;
  cplMaxMinor: number | null;
}

export interface LiveCampaign {
  dailyBudgetMinor: number;
  endAt: Date | null;
}

export interface ApprovalInput {
  role: string;
  caps: Caps;
  accountStatus: string;
  offset: number;
  proposal: { dailyBudgetMinor: number; durationDays: number };
  live: LiveCampaign[];
  monthSpentMinor: number;
  now: Date;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Days from `from` to the earlier of `until` and the end of the month (UTC), at least 0. */
export function daysLeftInMonth(from: Date, until: Date | null): number {
  const monthEnd = Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1);
  const end = Math.min(monthEnd, until ? until.getTime() : monthEnd);
  return Math.max(0, Math.ceil((end - from.getTime()) / 86_400_000));
}

export function checkApproval(input: ApprovalInput): Verdict {
  const { caps, proposal, now } = input;
  if (input.role !== "OWNER") return { ok: false, reason: "Reklamaga pul sarflashni faqat workspace egasi tasdiqlaydi" };
  if (input.accountStatus !== "ACTIVE") return { ok: false, reason: "Reklama akkaunti ulanmagan yoki xato holatda" };
  if (caps.dailyCapMinor === null || caps.monthlyCapMinor === null || caps.cplMaxMinor === null) {
    return { ok: false, reason: "Avval kunlik, oylik chegara va maksimal lid narxini (CPL) belgilang" };
  }
  if (!Number.isInteger(proposal.durationDays) || proposal.durationDays < 1 || proposal.durationDays > MAX_DURATION_DAYS) {
    return { ok: false, reason: `Muddat 1–${MAX_DURATION_DAYS} kun bo'lishi kerak` };
  }
  if (!Number.isInteger(proposal.dailyBudgetMinor) || proposal.dailyBudgetMinor < MIN_DAILY_BUDGET_MAJOR * input.offset) {
    return { ok: false, reason: "Kunlik byudjet juda kichik" };
  }
  const liveDaily = input.live.reduce((sum, c) => sum + c.dailyBudgetMinor, 0);
  if (liveDaily + proposal.dailyBudgetMinor > caps.dailyCapMinor) {
    return { ok: false, reason: "Kunlik chegaradan oshadi (ishlab turgan kampaniyalar bilan birga)" };
  }
  const newEnd = new Date(now.getTime() + proposal.durationDays * 86_400_000);
  const projected =
    input.monthSpentMinor +
    input.live.reduce((sum, c) => sum + c.dailyBudgetMinor * daysLeftInMonth(now, c.endAt), 0) +
    proposal.dailyBudgetMinor * daysLeftInMonth(now, newEnd);
  if (projected > caps.monthlyCapMinor) return { ok: false, reason: "Oylik chegaradan oshishi mumkin — byudjet yoki muddatni kamaytiring" };
  return { ok: true };
}

export type PauseReason = "daily_cap" | "monthly_cap" | "cpl";

/** Account-wide stop: every live campaign is paused. */
export function accountStop(caps: Caps, todaySpentMinor: number, monthSpentMinor: number): PauseReason | null {
  if (caps.dailyCapMinor !== null && todaySpentMinor >= caps.dailyCapMinor) return "daily_cap";
  if (caps.monthlyCapMinor !== null && monthSpentMinor >= caps.monthlyCapMinor) return "monthly_cap";
  return null;
}

/** One campaign too expensive per lead. */
export function cplTooHigh(cplMaxMinor: number | null, spendMinor: number, results: number): boolean {
  if (cplMaxMinor === null) return false;
  if (spendMinor < cplMaxMinor * CPL_JUDGE_AFTER) return false;
  return results === 0 || spendMinor / results > cplMaxMinor;
}

/** A post that did 2× its account median is worth a boost. */
export const BOOST_SCORE = 2;
export const BOOST_MIN_VIEWS = 300;
export const BOOST_LOOKBACK_DAYS = 14;
export const PROPOSAL_TTL_DAYS = 3;
export const DEFAULT_BOOST_DAYS = 5;

export function isBoostCandidate(stat: { score: number | null; views: number | null; publishedAt: Date }, now: Date): boolean {
  return (stat.score ?? 0) >= BOOST_SCORE && (stat.views ?? 0) >= BOOST_MIN_VIEWS && now.getTime() - stat.publishedAt.getTime() <= BOOST_LOOKBACK_DAYS * 86_400_000;
}
