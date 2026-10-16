/**
 * ETAP 8 — tiny Redis key/value helpers with an in-memory fallback.
 *
 * Used for the Sheets token cache, the per-integration rate window and the
 * DEAD-alert throttle. Redis is used only when `REDIS_URL` is set and
 * reachable; any Redis error silently falls back to a process-local map, so
 * a Redis outage can never block a delivery.
 */

import { getRedisConnection } from "@/lib/queue/client";

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

const memory = new Map<string, MemoryEntry>();

function hasRedis(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

function memGet(key: string, now = Date.now()): string | null {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key: string, value: string, ttlSec: number, now = Date.now()): void {
  if (memory.size > 5000) {
    for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
  }
  memory.set(key, { value, expiresAt: now + ttlSec * 1000 });
}

export async function kvGet(key: string): Promise<string | null> {
  if (hasRedis()) {
    try {
      const value = await getRedisConnection().get(key);
      if (value !== null && value !== undefined) return value;
    } catch {
      // fall through to memory
    }
  }
  return memGet(key);
}

export async function kvSet(key: string, value: string, ttlSec: number): Promise<void> {
  memSet(key, value, ttlSec);
  if (!hasRedis()) return;
  try {
    await getRedisConnection().set(key, value, "EX", Math.max(1, Math.floor(ttlSec)));
  } catch {
    // the memory copy is enough
  }
}

export async function kvDel(key: string): Promise<void> {
  memory.delete(key);
  if (!hasRedis()) return;
  try {
    await getRedisConnection().del(key);
  } catch {
    // ignore
  }
}

/** True when the key was free (and is now taken for `ttlSec`). */
export async function kvSetNx(key: string, ttlSec: number): Promise<boolean> {
  if (hasRedis()) {
    try {
      const res = await getRedisConnection().set(key, "1", "EX", Math.max(1, Math.floor(ttlSec)), "NX");
      return res === "OK";
    } catch {
      // fall through
    }
  }
  if (memGet(key) !== null) return false;
  memSet(key, "1", ttlSec);
  return true;
}

/** Fixed-window counter: increments and returns the new count for the current window. */
export async function kvIncrWindow(key: string, windowSec: number, now = Date.now()): Promise<number> {
  const bucket = `${key}:${Math.floor(now / 1000 / windowSec)}`;
  if (hasRedis()) {
    try {
      const redis = getRedisConnection();
      const count = await redis.incr(bucket);
      if (count === 1) await redis.expire(bucket, windowSec + 5);
      return count;
    } catch {
      // fall through
    }
  }
  const current = Number(memGet(bucket, now) ?? 0) + 1;
  memSet(bucket, String(current), windowSec + 5, now);
  return current;
}

/** Tests. */
export function resetKvForTests(): void {
  memory.clear();
}
