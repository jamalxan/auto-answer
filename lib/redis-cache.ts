/**
 * JSON values cached in Redis for a short time, for slow third-party reads
 * (Instagram Graph). Redis being down is never an error: the value is simply
 * loaded again.
 */

import { getRedisConnection } from "@/lib/queue/client";

export async function cachedJson<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const redis = getRedisConnection();
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    // Fall through to the source; the cache is only an optimisation.
  }
  const fresh = await load();
  await redis.set(key, JSON.stringify(fresh), "EX", ttlSeconds).catch(() => {});
  return fresh;
}

export async function dropCached(key: string): Promise<void> {
  await getRedisConnection()
    .del(key)
    .catch(() => {});
}
