/**
 * ETAP 9 — Engagement (giveaway, referral, gamification): dev-mode switches
 * and limits shared by every engagement module.
 *
 * Like the trigger engine it is invisible outside the developer area; the only
 * thing that touches the production webhook path is the account gate
 * (lib/engagement/gate.ts). ENGAGEMENT_DISABLED=1 is the kill switch: no
 * collector, no worker, no gate extension.
 */

export function isEngagementEnabled(): boolean {
  const flag = (process.env.ENGAGEMENT_DISABLED ?? "").trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}

/** Backfill reads at most this many comments of one post. */
export const BACKFILL_CAP = 5000;
/** Follow checks (one Graph call each) per second, per process. */
export const FOLLOW_CHECKS_PER_SECOND = 2;
/** Live collector: events handled per giveaway per maintenance tick. */
export const COLLECT_BATCH = 500;
/** The collector runs at most this often (the worker tick is a minute). */
export const COLLECT_MIN_INTERVAL_MS = 30_000;
/** CSV / record exports stop here. */
export const EXPORT_ROW_CAP = 10_000;
