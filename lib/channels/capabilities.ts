/**
 * Capability matrix loader. The defaults live in capabilities.json; an
 * operator can override single fields without a deploy through
 * CHANNEL_CAPABILITIES_JSON, e.g. {"instagram":{"publish_daily_limit":100}}.
 * An invalid override is ignored (logged once), never a crash.
 */

import defaults from "./capabilities.json";
import { CHANNELS, type ChannelCapabilities, type ChannelId } from "./types";

type Matrix = Record<ChannelId, ChannelCapabilities>;

let cached: { raw: string | undefined; matrix: Matrix } | null = null;

function merge(base: Matrix, override: unknown): Matrix {
  if (!override || typeof override !== "object") return base;
  const out = { ...base };
  for (const channel of CHANNELS) {
    const patch = (override as Record<string, unknown>)[channel];
    if (patch && typeof patch === "object") {
      const next = { ...out[channel] } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in next)) continue;
        const current = next[key];
        const sameType = (current === null || value === null) ? true : typeof current === typeof value && Array.isArray(current) === Array.isArray(value);
        if (sameType) next[key] = value;
      }
      out[channel] = next as unknown as ChannelCapabilities;
    }
  }
  return out;
}

export function capabilityMatrix(env: Record<string, string | undefined> = process.env): Matrix {
  const raw = env.CHANNEL_CAPABILITIES_JSON;
  if (cached && cached.raw === raw) return cached.matrix;
  let override: unknown = null;
  if (raw?.trim()) {
    try {
      override = JSON.parse(raw);
    } catch {
      console.warn("[channels] CHANNEL_CAPABILITIES_JSON is not valid JSON; using defaults");
    }
  }
  const matrix = merge(defaults as unknown as Matrix, override);
  cached = { raw, matrix };
  return matrix;
}

export function capabilitiesOf(channel: ChannelId): ChannelCapabilities {
  return capabilityMatrix()[channel];
}

/** Policy helpers every channel shares. */
export function privateReplyAllowed(channel: ChannelId, commentAt: Date, now = new Date()): boolean {
  const days = capabilitiesOf(channel).private_reply_window_days;
  return days !== null && now.getTime() - commentAt.getTime() <= days * 86_400_000;
}

export function dmWindowOpen(channel: ChannelId, lastInboundAt: Date | null, now = new Date()): boolean {
  const caps = capabilitiesOf(channel);
  if (!caps.supports_dm) return false;
  if (caps.dm_window_hours === null) return true;
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() <= caps.dm_window_hours * 3_600_000;
}
