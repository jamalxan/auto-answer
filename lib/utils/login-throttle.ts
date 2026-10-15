import { headers } from "next/headers";
import { getRedisConnection } from "@/lib/queue/client";

/**
 * Failed-login counter per client IP for the password-only panels (/admin,
 * /developer). Those accounts guard every tenant, so a password guessing
 * loop gets cut off after a handful of misses.
 *
 * Redis being down must not lock the owner out, so the limiter fails open.
 */

const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

export interface LoginThrottle {
  isLocked(): Promise<boolean>;
  recordFailure(): Promise<void>;
}

export async function loginThrottle(scope: string): Promise<LoginThrottle> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "unknown";
  const key = `${scope}-login-failures:${ip}`;

  return {
    async isLocked() {
      try {
        return (Number(await getRedisConnection().get(key)) || 0) >= LOGIN_FAILURE_LIMIT;
      } catch (err) {
        console.error(`[${scope}] login limiter unavailable:`, err);
        return false;
      }
    },
    async recordFailure() {
      try {
        const redis = getRedisConnection();
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, LOGIN_FAILURE_WINDOW_SECONDS);
      } catch (err) {
        console.error(`[${scope}] login limiter unavailable:`, err);
      }
    },
  };
}
