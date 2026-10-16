/**
 * The webhook account gate (lib/triggers/ingest.ts loadAccountGate) stores
 * events only for accounts that are "engaged". An ACTIVE giveaway or an active
 * referral program engages the account too — otherwise its comments and ig.me
 * refs would never become InstagramEvent rows for the collector to read.
 */

import { prisma } from "@/lib/db/client";
import { isEngagementEnabled } from "./config";

/** True when the account (InstagramAccount row id) runs an ACTIVE giveaway or an active referral program. */
export async function hasActiveEngagement(instagramAccountId: string): Promise<boolean> {
  if (!isEngagementEnabled()) return false;
  try {
    const giveaways = await prisma.giveaway.count({ where: { instagramAccountId, status: "ACTIVE" } });
    if (giveaways > 0) return true;
    const programs = await prisma.referralProgram.count({ where: { instagramAccountId, active: true } });
    return programs > 0;
  } catch (error) {
    // The gate must never break the webhook path (e.g. migration not applied yet).
    console.error("[Engagement] gate check failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Drop the cached webhook gate of an account right after a giveaway is
 * activated / closed or a referral program is switched. Takes the
 * InstagramAccount row id (looked up to the Instagram id the cache is keyed
 * by). Imported lazily: ingest.ts imports this file.
 */
export async function forgetEngagementGate(instagramAccountId: string): Promise<void> {
  try {
    const account = await prisma.instagramAccount.findUnique({
      where: { id: instagramAccountId },
      select: { instagramId: true },
    });
    const { forgetAccountGate } = await import("@/lib/triggers/ingest");
    forgetAccountGate(account?.instagramId);
  } catch (error) {
    console.error("[Engagement] could not refresh the account gate:", error instanceof Error ? error.message : error);
  }
}
