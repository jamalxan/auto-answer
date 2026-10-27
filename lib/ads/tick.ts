/**
 * Ads tick from the content worker's minute loop, runs every 15 min:
 * guard (insights → caps / CPL pauses), boost suggestions, CAPI sends.
 * Returns null on the minutes it does not run.
 */

import { getRedisConnection } from "@/lib/queue/client";

export const ADS_EVERY_SEC = 15 * 60;

export async function adsTick(now = new Date()) {
  try {
    if ((await getRedisConnection().set("ads:tick", "1", "EX", ADS_EVERY_SEC, "NX")) !== "OK") return null;
  } catch {
    return null;
  }
  const { guardAds, sendPendingSaleEvents, suggestBoosts } = await import("./service");
  // The guard first: stopping spend matters more than proposing new spend.
  const guard = await guardAds(now);
  const suggested = await suggestBoosts(now).catch((error) => {
    console.error("[ads] suggestions failed:", error instanceof Error ? error.message : error);
    return 0;
  });
  const capi = await sendPendingSaleEvents(now);
  return { ...guard, suggested, capiSent: capi.sent, capiFailed: capi.failed };
}
