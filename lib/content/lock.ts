/**
 * ETAP 13 — one publish per Instagram account at a time (spec §7
 * "Konkurensiya"). Redis SET NX with a token and compare-and-delete release
 * (same pattern as lib/javobai/runtime.ts); without REDIS_URL (unit tests,
 * scripts) an in-process map serialises callers instead.
 */

import { randomUUID } from "node:crypto";
import { getRedisConnection } from "@/lib/queue/client";

const LOCK_TTL_SEC = 180;
const RELEASE_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

export function accountLockKey(accountId: string): string {
  return `content:acct:${accountId}`;
}

const local = new Map<string, string>();

async function acquire(key: string): Promise<string | null> {
  const token = randomUUID();
  if (!process.env.REDIS_URL?.trim()) {
    if (local.has(key)) return null;
    local.set(key, token);
    return token;
  }
  const result = await getRedisConnection().set(key, token, "EX", LOCK_TTL_SEC, "NX");
  return result === "OK" ? token : null;
}

async function release(key: string, token: string): Promise<void> {
  if (!process.env.REDIS_URL?.trim()) {
    if (local.get(key) === token) local.delete(key);
    return;
  }
  await getRedisConnection().eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
}

export type Locked<T> = { acquired: true; result: T } | { acquired: false };

/** Run `fn` while holding the account's lock, or report that someone else holds it. */
export async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<Locked<T>> {
  return withKeyLock(accountLockKey(accountId), fn);
}

/** The same lock for any key (e.g. one manual notice per post while two sweepers overlap). */
export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<Locked<T>> {
  const token = await acquire(key);
  if (!token) return { acquired: false };
  try {
    return { acquired: true, result: await fn() };
  } finally {
    await release(key, token);
  }
}
