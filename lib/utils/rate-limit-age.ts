/**
 * Hard age cap for sends held back by the hourly DM cap. Pure, no Redis.
 */

/** A DM held back by the hourly cap is given up after this long (Meta's 24h messaging window). */
export const RATE_LIMIT_MAX_AGE_DM_MS = 24 * 3600_000;
/** A private reply to a comment is given up after this long (Meta's 7-day private-reply limit). */
export const RATE_LIMIT_MAX_AGE_PRIVATE_REPLY_MS = 7 * 24 * 3600_000;
export const RATE_LIMIT_EXPIRED_MESSAGE = "Soatlik limit tufayli yuborilmadi — muddat o'tdi";

/**
 * True when a send that keeps hitting the hourly cap is too old to be worth
 * retrying: `startedAt` is the comment / message time (or when the work was
 * first created). Pure — tests drive it with a fake clock.
 */
export function isRateLimitExpired(
  startedAt: Date | number | null | undefined,
  kind: "dm" | "private_reply",
  now: Date | number = Date.now()
): boolean {
  if (startedAt === null || startedAt === undefined) return false;
  const start = startedAt instanceof Date ? startedAt.getTime() : startedAt;
  if (!Number.isFinite(start)) return false;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const max = kind === "dm" ? RATE_LIMIT_MAX_AGE_DM_MS : RATE_LIMIT_MAX_AGE_PRIVATE_REPLY_MS;
  return nowMs - start >= max;
}

