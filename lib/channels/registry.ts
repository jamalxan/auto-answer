/**
 * Channel → adapter. A channel without an adapter returns null and every
 * caller treats it as "not connected", never as a crash.
 */

import { facebookAdapter } from "./facebook";
import { instagramAdapter } from "./instagram";
import { telegramAdapter } from "./telegram";
import { threadsAdapter } from "./threads";
import type { ChannelAdapter, ChannelId } from "./types";
import { youtubeAdapter } from "./youtube";

const ADAPTERS: Partial<Record<ChannelId, ChannelAdapter>> = {
  instagram: instagramAdapter,
  telegram: telegramAdapter,
  facebook: facebookAdapter,
  threads: threadsAdapter,
  youtube: youtubeAdapter,
};

export function adapterFor(channel: ChannelId): ChannelAdapter | null {
  return ADAPTERS[channel] ?? null;
}

/** Tests register fake adapters here. */
export function registerAdapter(adapter: ChannelAdapter): void {
  ADAPTERS[adapter.channel] = adapter;
}
