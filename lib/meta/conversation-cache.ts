/**
 * Short-lived Redis cache for an account's Instagram conversation list.
 *
 * Meta takes ~3.5s to return the 50 latest threads with their last message,
 * and the inbox re-asks every 12s. The list only changes when a DM comes in
 * or goes out, and both of those reach us (the webhook, our own send), so the
 * cache is dropped right then; the TTL only bounds a missed webhook.
 */

import { cachedJson, dropCached } from "@/lib/redis-cache";

const TTL_SECONDS = 60;

const keyFor = (instagramId: string) => `ig:conv-list:${instagramId}`;

export function cachedConversationList<T>(instagramId: string, load: () => Promise<T>): Promise<T> {
  return cachedJson(keyFor(instagramId), TTL_SECONDS, load);
}

export function invalidateConversationList(instagramId: string): Promise<void> {
  return dropCached(keyFor(instagramId));
}
