/**
 * Click-to-Instagram-Direct (audit 2026-10-26, phase 7): a DM opened from an
 * ad carries `referral` (source ADS, ad_id, ads_context_data.ad_title…).
 * We keep it per customer so JavobAI knows which product the thread is
 * about. The ad title is the advertiser's text, still passed to the model as
 * data, never as an instruction.
 */

import { prisma } from "@/lib/db/client";

export const REFERRAL_TTL_DAYS = 7;

export interface ParsedReferral {
  igAccountId: string;
  igUserId: string;
  adId: string;
  adTitle: string | null;
  postId: string | null;
  productId: string | null;
  source: string | null;
}

interface RawReferral {
  ref?: string;
  ad_id?: string;
  source?: string;
  type?: string;
  ads_context_data?: { ad_title?: string; post_id?: string; product_id?: string };
}

export function parseAdReferrals(payload: unknown): ParsedReferral[] {
  if (!payload || typeof payload !== "object" || (payload as { object?: string }).object !== "instagram") return [];
  const out: ParsedReferral[] = [];
  for (const entry of (payload as { entry?: Array<{ id?: string; messaging?: Array<{ sender?: { id?: string }; referral?: RawReferral; message?: { referral?: RawReferral; is_echo?: boolean } }> }> }).entry ?? []) {
    for (const item of entry.messaging ?? []) {
      const referral = item.message?.referral ?? item.referral;
      const sender = item.sender?.id;
      if (!referral?.ad_id || !sender || !entry.id || sender === entry.id || item.message?.is_echo) continue;
      out.push({
        igAccountId: entry.id,
        igUserId: sender,
        adId: referral.ad_id,
        adTitle: referral.ads_context_data?.ad_title?.slice(0, 200) ?? null,
        postId: referral.ads_context_data?.post_id ?? null,
        productId: referral.ads_context_data?.product_id ?? null,
        source: referral.source ?? null,
      });
    }
  }
  return out;
}

/** Store referrals of connected accounts (best effort from the webhook route). */
export async function storeAdReferrals(payload: unknown): Promise<number> {
  let stored = 0;
  for (const ref of parseAdReferrals(payload)) {
    const account = await prisma.instagramAccount.findUnique({ where: { instagramId: ref.igAccountId }, select: { id: true } });
    if (!account) continue;
    try {
      await prisma.adReferral.create({ data: { instagramAccountId: account.id, igUserId: ref.igUserId, adId: ref.adId, adTitle: ref.adTitle, postId: ref.postId, productId: ref.productId, source: ref.source } });
      stored++;
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }
  return stored;
}

/** The ad this customer came from in the last 7 days, if any. */
export async function latestAdReferral(instagramAccountId: string, igUserId: string, now = new Date()) {
  return prisma.adReferral.findFirst({
    where: { instagramAccountId, igUserId, createdAt: { gte: new Date(now.getTime() - REFERRAL_TTL_DAYS * 86_400_000) } },
    orderBy: { createdAt: "desc" },
    select: { adId: true, adTitle: true, postId: true },
  });
}
