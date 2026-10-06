import { getRedisConnection } from "@/lib/queue/client";

/**
 * Per-integration request throttle (token bucket, one-second window) in Redis.
 * amoCRM allows ~7 req/s, Bitrix24 2 req/s per portal; we stay under both.
 * Resolves when a slot is free. If Redis is unreachable we do not block
 * delivery — the CRM's own 429 handling still protects us.
 */
export async function acquireSlot(key: string, perSecond: number): Promise<void> {
  const redis = getRedisConnection();
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const window = Math.floor(Date.now() / 1000);
      const redisKey = `throttle:${key}:${window}`;
      const count = await redis.incr(redisKey);
      if (count === 1) await redis.expire(redisKey, 2);
      if (count <= perSecond) return;
    } catch {
      return;
    }
    const msToNextWindow = 1000 - (Date.now() % 1000);
    await new Promise((resolve) => setTimeout(resolve, msToNextWindow + 5));
  }
}
