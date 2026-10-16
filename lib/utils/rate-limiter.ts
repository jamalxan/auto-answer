/**
 * Rate Limiter
 *
 * Redis-based rate limiter for Instagram private replies.
 *
 * The hourly outbound DM cap per Instagram account is configurable (B-03):
 *
 *   - default `DM_HOURLY_LIMIT_DEFAULT` env, else 200 per hour (the TZ value);
 *   - per-account override: InstagramAccount.dmHourlyLimit (null = default).
 *
 * OWNER DECISION: Meta documents 750 private replies/hour for comment-triggered
 * private replies and a separate budget for the Send API; these figures change.
 * The owner must confirm the right number against Meta's current documentation
 * (https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ and
 * the Instagram Messaging API rate-limit section) and set the env / the
 * per-account value accordingly. The old hard-coded 750 is gone.
 *
 * When the cap is reached a send is NEVER dropped: the caller reschedules it
 * to the start of the next window (the Redis counter's remaining TTL) plus a
 * growing backoff/jitter per attempt, so a burst drains over several hours.
 */

import Redis from "ioredis";

export const DEFAULT_HOURLY_DM_LIMIT = 200;

/** Env default (DM_HOURLY_LIMIT_DEFAULT), falling back to 200. Read on every call so a restart-free env change in tests works. */
export function defaultHourlyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt((env.DM_HOURLY_LIMIT_DEFAULT ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOURLY_DM_LIMIT;
}

const RATE_LIMIT_MAX = defaultHourlyLimit(); // default per-account cap; see the file comment
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds
const REQUEUE_DELAY_MS = 30 * 60 * 1000; // fallback when the window's TTL is unknown
const MAX_REQUEUE_ATTEMPTS = 3; // kept for callers; attempts no longer cause a drop
const BACKOFF_STEP_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

const limitCache = new Map<string, { value: number; expires: number }>();

/** Per-account cap: InstagramAccount.dmHourlyLimit when set, else the default. Never throws. */
export async function getAccountHourlyLimit(instagramAccountId: string): Promise<number> {
  const fallback = defaultHourlyLimit();
  const cached = limitCache.get(instagramAccountId);
  if (cached && cached.expires > Date.now()) return cached.value;
  let value = fallback;
  try {
    const { prisma } = await import("@/lib/db/client");
    const row = await prisma.instagramAccount.findUnique({
      where: { instagramId: instagramAccountId },
      select: { dmHourlyLimit: true },
    });
    if (row?.dmHourlyLimit && row.dmHourlyLimit > 0) value = row.dmHourlyLimit;
  } catch {
    // no database (unit tests, outage): the default stands
  }
  limitCache.set(instagramAccountId, { value, expires: Date.now() + 60_000 });
  return value;
}

export function forgetAccountHourlyLimit(instagramAccountId?: string) {
  if (instagramAccountId) limitCache.delete(instagramAccountId);
  else limitCache.clear();
}

/**
 * Delay for a blocked send: until the current window ends (the counter's TTL)
 * plus a per-attempt backoff, so retries spread out instead of stampeding the
 * new window. Pure — tested with a fake clock.
 */
export function nextWindowDelayMs(ttlSeconds: number | null, requeueAttempt: number, random = Math.random()): number {
  const base = ttlSeconds !== null && ttlSeconds > 0 ? ttlSeconds * 1000 : REQUEUE_DELAY_MS;
  const backoff = Math.min(BACKOFF_MAX_MS, Math.max(0, requeueAttempt) * BACKOFF_STEP_MS);
  return base + Math.floor(backoff * (0.5 + random / 2)) + 1_000;
}

// The hard age cap (M3) lives in ./rate-limit-age.ts (pure; importable where this module is mocked).
export * from "./rate-limit-age";

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return redis;
}

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingDMs: number;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

const RESERVE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
local max = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

if current >= max then
  return {0, current, 0, redis.call("TTL", KEYS[1])}
end

local next_count = redis.call("INCR", KEYS[1])
if next_count == 1 then
  redis.call("EXPIRE", KEYS[1], ttl)
end

return {1, next_count, max - next_count}
`;

const RELEASE_DM_SLOT_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if current <= 0 then
  return 0
end
return redis.call("DECR", KEYS[1])
`;

function toScriptNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseInt(value, 10);
  return 0;
}

function blockedResult(count: number, requeueAttempt: number, ttlSeconds: number | null = null): RateLimitResult {
  // Never skip: a send over the cap waits for the next window (with backoff).
  return {
    allowed: false,
    currentCount: count,
    remainingDMs: 0,
    shouldRequeue: true,
    requeueDelayMs: nextWindowDelayMs(ttlSeconds, requeueAttempt),
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Check if an Instagram account is within its DM rate limit.
 *
 * Uses a Redis counter with a 1-hour TTL per account.
 * Key pattern: `rate:dm:{instagramAccountId}`
 *
 * @param instagramAccountId - The Instagram account ID to check
 * @param requeueAttempt - How many times this job has been requeued (0 = first attempt)
 * @returns Rate limit result with action recommendations
 */
export async function checkRateLimit(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const currentCount = await client.get(key);
  const count = currentCount ? parseInt(currentCount, 10) : 0;
  const limit = await getAccountHourlyLimit(instagramAccountId);

  if (count >= limit) {
    const ttl = typeof client.ttl === "function" ? await client.ttl(key) : null;
    return blockedResult(count, requeueAttempt, ttl);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: limit - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a DM send slot for an Instagram account.
 * This is the worker-safe path; it prevents concurrent jobs from all passing
 * the rate-limit check before any of them increments the Redis counter.
 */
export async function reserveDMSlot(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;

  const result = await client.eval(
    RESERVE_DM_SLOT_SCRIPT,
    1,
    key,
    await getAccountHourlyLimit(instagramAccountId),
    RATE_LIMIT_WINDOW
  );
  const values = Array.isArray(result) ? result : [];
  const allowedFlag = toScriptNumber(values[0]);
  const count = toScriptNumber(values[1]);
  const remaining = toScriptNumber(values[2]);

  if (allowedFlag !== 1) {
    return blockedResult(count, requeueAttempt, values.length > 3 ? toScriptNumber(values[3]) : null);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: remaining,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  };
}

/**
 * Give back a slot taken by reserveDMSlot when the send itself failed, so
 * failed attempts (and their retries) don't eat into the hourly cap. Never
 * drops the counter below zero.
 */
export async function releaseDMSlot(instagramAccountId: string): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const result = await client.eval(RELEASE_DM_SLOT_SCRIPT, 1, key);
  return toScriptNumber(result);
}

/**
 * Backwards-compatible helper for tests and admin scripts.
 * Prefer reserveDMSlot in workers.
 */
export async function incrementDMCounter(
  instagramAccountId: string
): Promise<number> {
  const result = await reserveDMSlot(instagramAccountId, MAX_REQUEUE_ATTEMPTS);
  return result.currentCount;
}

/**
 * Get the current DM count for an Instagram account.
 */
export async function getCurrentDMCount(
  instagramAccountId: string
): Promise<number> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  const count = await client.get(key);
  return count ? parseInt(count, 10) : 0;
}

/**
 * Reset the rate limiter for an account (useful for testing).
 */
export async function resetRateLimit(
  instagramAccountId: string
): Promise<void> {
  const client = getRedis();
  const key = `rate:dm:${instagramAccountId}`;
  await client.del(key);
}

// Export constants for use in tests
export { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, REQUEUE_DELAY_MS, MAX_REQUEUE_ATTEMPTS };
