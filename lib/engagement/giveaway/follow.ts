/**
 * Follow check ("does this person follow the business?") for a giveaway.
 *
 * One Graph call per person (`is_user_follow_business`), throttled to
 * FOLLOW_CHECKS_PER_SECOND per process. The answer is cached on the entry
 * (followResult / followCheckedAt); only NOT_CHECKED entries are asked, and
 * UNVERIFIABLE ones are asked again after FOLLOW_RECHECK_MS (a person who
 * later writes to the account becomes verifiable). Meta answers null for
 * people it cannot verify — that is UNVERIFIABLE, never "not a follower".
 */

import { getUserFollowStatus } from "@/lib/meta/client";
import { FOLLOW_CHECKS_PER_SECOND } from "../config";
import type { FollowResult } from "./rules";

/** Follow checks per giveaway per collector tick (a tick is about a minute). */
export const FOLLOW_BUDGET_PER_TICK = 40;
/** An UNVERIFIABLE answer is asked again after this long. */
export const FOLLOW_RECHECK_MS = 6 * 3600_000;

const throttle = {
  intervalMs: Math.ceil(1000 / FOLLOW_CHECKS_PER_SECOND),
  nextAt: 0,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const startAt = Math.max(now, throttle.nextAt);
  throttle.nextAt = startAt + throttle.intervalMs;
  if (startAt > now) await throttle.sleep(startAt - now);
}

/** Tests: no waiting between checks. */
export function setFollowThrottleForTests(intervalMs: number, sleep?: (ms: number) => Promise<void>): void {
  throttle.intervalMs = intervalMs;
  throttle.nextAt = 0;
  throttle.sleep = sleep ?? (async () => {});
}

/** One throttled check. A transport error counts as UNVERIFIABLE (asked again later). */
export async function checkFollow(accessToken: string, igUserId: string): Promise<Exclude<FollowResult, "NOT_CHECKED">> {
  await waitForSlot();
  try {
    const follows = await getUserFollowStatus(accessToken, igUserId);
    if (follows === true) return "FOLLOWER";
    if (follows === false) return "NOT_FOLLOWER";
    return "UNVERIFIABLE";
  } catch {
    return "UNVERIFIABLE";
  }
}

/** Is it time to ask about this entry (never asked, or an old UNVERIFIABLE)? */
export function followCheckDue(
  entry: { followResult: string; followCheckedAt: Date | null },
  now: Date
): boolean {
  if (entry.followResult === "NOT_CHECKED") return true;
  if (entry.followResult !== "UNVERIFIABLE") return false;
  if (!entry.followCheckedAt) return true;
  return now.getTime() - entry.followCheckedAt.getTime() >= FOLLOW_RECHECK_MS;
}
