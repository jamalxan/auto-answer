/**
 * Outbound calls of the channel layer (audit 2026-10-26, T0/T7):
 *
 *   - timeout on every call
 *   - retry with exponential backoff + full jitter on network errors / 5xx
 *   - 429: wait Retry-After (capped) once, then give up with a rate_limit error
 *   - an Idempotency-Key header when the caller has one
 *   - a per-tenant hourly cap (denial-of-wallet: one tenant's loop cannot
 *     burn the app's platform quota for everyone)
 */

import { getRedisConnection } from "@/lib/queue/client";
import { ChannelError } from "./types";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_RETRIES = 3;
export const MAX_RETRY_AFTER_SEC = 30;
/** Outbound channel API calls one workspace may make per hour (env CHANNEL_API_CALLS_PER_HOUR). */
export const DEFAULT_TENANT_CALLS_PER_HOUR = 3000;

export interface ChannelFetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  idempotencyKey?: string;
  /** Counted against this workspace's hourly cap. */
  tenantId?: string | null;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function backoffMs(attempt: number, baseMs = 300, capMs = 8_000): number {
  // Full jitter: random in [0, min(cap, base·2^attempt)].
  return Math.floor(Math.random() * Math.min(capMs, baseMs * 2 ** attempt));
}

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Fixed hourly window per tenant; Redis down = allowed (never block customers on our own infra). */
export async function consumeTenantCall(tenantId: string, limit = Number(process.env.CHANNEL_API_CALLS_PER_HOUR) || DEFAULT_TENANT_CALLS_PER_HOUR): Promise<boolean> {
  try {
    const key = `chan:calls:${tenantId}:${Math.floor(Date.now() / 3_600_000)}`;
    const redis = getRedisConnection();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 3_700);
    return count <= limit;
  } catch {
    return true;
  }
}

export async function channelFetch(url: string, options: ChannelFetchOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = MAX_RETRIES, idempotencyKey, tenantId, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...init } = options;
  if (tenantId && !(await consumeTenantCall(tenantId))) {
    throw new ChannelError("rate_limit", "Soatlik API chaqiruvlar chegarasi tugadi", 3600);
  }
  const headers = new Headers(init.headers);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  let rateLimitedOnce = false;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt >= retries) throw new ChannelError("transient", `Tarmoq xatosi: ${error instanceof Error ? error.name : "unknown"}`);
      await sleep(backoffMs(attempt));
      continue;
    }
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after")) ?? 5;
      if (rateLimitedOnce || retryAfter > MAX_RETRY_AFTER_SEC) throw new ChannelError("rate_limit", "Platforma so'rovlarni cheklab qo'ydi", retryAfter);
      rateLimitedOnce = true;
      await sleep(retryAfter * 1000);
      continue;
    }
    if (response.status >= 500 && attempt < retries) {
      await sleep(backoffMs(attempt));
      continue;
    }
    return response;
  }
}
