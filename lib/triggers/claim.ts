/**
 * Overlap guard between Comment 2.0 and the production comment campaigns.
 *
 * Meta allows one private reply per comment. When an active Comment 2.0
 * campaign will answer a comment, the production worker (processComment in
 * lib/queue/dm-worker.ts) asks here first and steps aside, so nobody gets two
 * DMs and no production campaign burns the one allowed reply.
 *
 * The production worker calls this for every comment, so "this account has no
 * active COMMENT campaign" is cached per account for a short while — the hot
 * path: only the developer can create Comment 2.0 campaigns, so for every
 * other account the answer is a cached "no campaigns" and nothing changes.
 * When campaigns exist they are always read fresh: a cached "claimed" could
 * outlive a campaign switched off, deleted or narrowed in another process (the
 * UI's forget calls only reach its own process), and then production would
 * step aside while the engine ignores the comment — nobody answers it.
 *
 * Failures answer false: on any doubt production keeps working as before.
 * Kept free of lib/meta imports on purpose (the production worker loads it).
 */

import { prisma } from "@/lib/db/client";
import { isTriggerEngineEnabled } from "./config";
import { selectCommentCampaign, type CommentMatchableCampaign } from "./matching";
import { isC2Payload } from "./normalize";

const CLAIM_TTL_MS = 30_000;
/** Accounts known to have no active COMMENT campaign, until `expires`. */
const noCampaignsCache = new Map<string, number>();

/** Drop cached "no campaigns" answers (one account, by either id, or all). */
export function forgetCommentClaims(accountKey?: string) {
  if (accountKey) noCampaignsCache.delete(accountKey);
  else noCampaignsCache.clear();
}

/**
 * Active COMMENT campaigns of an account. `accountKey` may be our
 * InstagramAccount.id or the Instagram id (webhook entry.id) — the production
 * worker only has the latter.
 */
async function loadCampaigns(accountKey: string): Promise<CommentMatchableCampaign[]> {
  const emptyUntil = noCampaignsCache.get(accountKey);
  if (emptyUntil !== undefined) {
    if (emptyUntil > Date.now()) return [];
    noCampaignsCache.delete(accountKey);
  }

  const campaigns = await prisma.triggerCampaign.findMany({
    where: {
      triggerType: "COMMENT",
      active: true,
      OR: [{ instagramAccountId: accountKey }, { instagramAccount: { instagramId: accountKey } }],
    },
    select: {
      id: true,
      triggerType: true,
      active: true,
      mediaScope: true,
      mediaIds: true,
      keywords: true,
      matchingMode: true,
      intents: true,
      priority: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (campaigns.length === 0) noCampaignsCache.set(accountKey, Date.now() + CLAIM_TTL_MS);
  return campaigns;
}

/** True when an active Comment 2.0 campaign on this account will answer the comment. */
export async function isCommentClaimedByCommentEngine(
  instagramAccountId: string,
  mediaId: string | null,
  text: string,
  altMediaId?: string | null
): Promise<boolean> {
  if (!isTriggerEngineEnabled() || !instagramAccountId) return false;
  try {
    const campaigns = await loadCampaigns(instagramAccountId);
    if (campaigns.length === 0) return false;
    return selectCommentCampaign(campaigns, { mediaId, altMediaId, text }).campaign !== null;
  } catch (error) {
    console.error(
      "[Trigger Engine] comment claim check failed, production handles the comment:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/**
 * A quick-reply payload that belongs to Comment 2.0. The webhook route keeps
 * such messages away from the DM keyword path and the assistant (see
 * findClaimedC2Messages in ingest.ts, which applies this to a whole payload).
 */
export function isClaimedC2Payload(payload: string | null | undefined): boolean {
  return isTriggerEngineEnabled() && isC2Payload(payload);
}
