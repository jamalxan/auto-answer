/**
 * Channel → adapter. A channel without an adapter yet (facebook, threads,
 * youtube until their phases land) returns null and every caller
 * treats it as "not connected", never as a crash.
 */

import { instagramAdapter } from "./instagram";
import { telegramAdapter } from "./telegram";
import type { ChannelAdapter, ChannelId } from "./types";

const ADAPTERS: Partial<Record<ChannelId, ChannelAdapter>> = {
  instagram: instagramAdapter,
  telegram: telegramAdapter,
};

export function adapterFor(channel: ChannelId): ChannelAdapter | null {
  return ADAPTERS[channel] ?? null;
}

/** Tests and later phases register adapters here. */
export function registerAdapter(adapter: ChannelAdapter): void {
  ADAPTERS[adapter.channel] = adapter;
}
