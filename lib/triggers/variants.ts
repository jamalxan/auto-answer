/**
 * Reply variants (TZ 9): which of a campaign's texts goes out this time.
 *
 *   RANDOM     — uniform over the usable variants
 *   SEQUENTIAL — round robin; the cursor lives on the campaign and moves
 *                atomically, so two workers never send the same index twice
 *   WEIGHTED   — chance proportional to `weight` (all-zero → uniform)
 *
 * Only approved variants with text are usable (TZ 10: AI drafts are never sent
 * before someone approves them). With no usable DM variant the campaign's
 * `responseMessage` is the reply, so a campaign always has something to say.
 *
 * The choice is made once, when the execution is created, and stored on it
 * (responseText + variantId): a retry re-sends the same text and the
 * sequence cursor moves once per comment, not once per attempt.
 */

import { prisma } from "@/lib/db/client";

export type ReplyMode = "RANDOM" | "SEQUENTIAL" | "WEIGHTED";
export type VariantKind = "DM" | "PUBLIC";

export interface PickableVariant {
  id: string;
  kind?: VariantKind;
  text: string;
  weight: number;
  sort: number;
  approvedAt: Date | null;
  createdAt?: Date;
}

/** Approved, non-empty variants of one kind, in builder order. */
export function usableVariants<V extends PickableVariant>(variants: V[], kind?: VariantKind): V[] {
  return variants
    .filter((v) => (!kind || v.kind === kind) && v.approvedAt !== null && v.text.trim().length > 0)
    .sort((a, b) => a.sort - b.sort || (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
}

/**
 * Pure choice among already-usable variants. `cursor` is the SEQUENTIAL
 * position (any integer, wrapped); `rng` returns [0, 1).
 */
export function pickVariant<V extends PickableVariant>(
  variants: V[],
  mode: ReplyMode,
  cursor: number,
  rng: () => number = Math.random
): V | null {
  if (variants.length === 0) return null;
  if (mode === "SEQUENTIAL") {
    const n = variants.length;
    return variants[((Math.trunc(cursor) % n) + n) % n];
  }
  if (mode === "WEIGHTED") {
    const weights = variants.map((v) => Math.max(0, Number.isFinite(v.weight) ? v.weight : 0));
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total > 0) {
      let roll = rng() * total;
      for (let i = 0; i < variants.length; i++) {
        roll -= weights[i];
        if (roll < 0) return variants[i];
      }
      return variants[variants.length - 1];
    }
  }
  return variants[Math.min(variants.length - 1, Math.floor(rng() * variants.length))];
}

export interface CampaignReplyConfig {
  id: string;
  replyMode: ReplyMode;
  sequenceCursor: number;
  responseMessage: string;
}

export async function loadApprovedVariants(campaignId: string) {
  return prisma.triggerReplyVariant.findMany({
    where: { campaignId, approvedAt: { not: null } },
    orderBy: [{ sort: "asc" }, { createdAt: "asc" }],
  });
}

/** Moves the SEQUENTIAL cursor by one and returns the position this send owns. */
export async function claimSequencePosition(campaignId: string): Promise<number> {
  const updated = await prisma.triggerCampaign.update({
    where: { id: campaignId },
    data: { sequenceCursor: { increment: 1 } },
    select: { sequenceCursor: true },
  });
  return updated.sequenceCursor - 1;
}

export interface ChosenReplies {
  dm: { text: string; variantId: string | null };
  /** Null when the campaign has no approved PUBLIC variant. */
  publicText: string | null;
  /** SEQUENTIAL position used, for the log; null for the other modes. */
  cursor: number | null;
}

/**
 * The DM and public texts for one new comment execution. `dryRun` (the
 * simulator) previews the next position without moving the cursor.
 */
export async function chooseReplies(
  campaign: CampaignReplyConfig,
  variants: PickableVariant[],
  options: { dryRun?: boolean; rng?: () => number } = {}
): Promise<ChosenReplies> {
  const dmPool = usableVariants(variants, "DM");
  const publicPool = usableVariants(variants, "PUBLIC");

  let cursor: number | null = null;
  if (campaign.replyMode === "SEQUENTIAL" && (dmPool.length > 0 || publicPool.length > 0)) {
    cursor = options.dryRun ? campaign.sequenceCursor : await claimSequencePosition(campaign.id);
  }

  const dm = pickVariant(dmPool, campaign.replyMode, cursor ?? 0, options.rng);
  const publicVariant = pickVariant(publicPool, campaign.replyMode, cursor ?? 0, options.rng);
  return {
    dm: dm ? { text: dm.text, variantId: dm.id } : { text: campaign.responseMessage, variantId: null },
    publicText: publicVariant?.text ?? null,
    cursor,
  };
}
