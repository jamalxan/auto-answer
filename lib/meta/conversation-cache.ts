/**
 * Short-lived Redis cache for an account's Instagram conversation list.
 *
 * Meta takes ~3.5s to return the 50 latest threads with their last message,
 * and the inbox re-asks every 12s. The list only changes when a DM comes in
 * or goes out, and both of those reach us (the webhook, our own send), so the
 * cache is dropped right then; the TTL only bounds a missed webhook.
 */

import { getRedisConnection } from "@/lib/queue/client";

const TTL_SECONDS = 60;

const keyFor = (instagramId: string) => `ig:conv-list:${instagramId}`;

export async function cachedConversationList<T>(
  instagramId: string,
  load: () => Promise<T>
): Promise<T> {
  const redis = getRedisConnection();
  try {
    const hit = await redis.get(keyFor(instagramId));
    if (hit) return JSON.parse(hit) as T;
  } catch {
    // Redis down: fall through to Meta, the cache is only an optimisation.
  }
  const fresh = await load();
  await redis.set(keyFor(instagramId), JSON.stringify(fresh), "EX", TTL_SECONDS).catch(() => {});
  return fresh;
}

export async function invalidateConversationList(instagramId: string): Promise<void> {
  await getRedisConnection()
    .del(keyFor(instagramId))
    .catch(() => {});
}
