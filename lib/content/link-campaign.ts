/**
 * ETAP 13 — post ↔ comment-to-DM campaign binding (spec FR-L1…FR-L5).
 *
 * A linked campaign is parked on the post (scheduledPostId set, switched
 * off, no media bound) and does nothing until the publish transaction
 * writes the real Instagram media id and switches it on — so the webhook
 * finds the campaign ready for the first comment, with no attach-next-reel
 * polling in between. Works for both engines: the legacy Automation
 * (postId) and the Comment 2.0 TriggerCampaign (mediaIds / SPECIFIC).
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { ContentError, notFound } from "./errors";

export interface CampaignLink {
  automationId?: string;
  triggerCampaignId?: string;
}

export interface LinkedCampaignSummary {
  kind: "automation" | "trigger";
  id: string;
  name: string;
  keywords: string[];
  active: boolean;
  /** Linked but not yet bound to a published media id. */
  waiting: boolean;
}

type Tx = Prisma.TransactionClient | typeof prisma;

async function loadPost(workspaceId: string, postId: string) {
  const post = await prisma.scheduledPost.findUnique({ where: { id: postId }, select: { id: true, workspaceId: true, instagramAccountId: true, deletedAt: true } });
  if (!post || post.workspaceId !== workspaceId || post.deletedAt) throw notFound();
  return post;
}

/** Unlink whatever the post currently holds (both engines). */
async function detachAll(tx: Tx, postId: string): Promise<void> {
  await tx.automation.updateMany({ where: { scheduledPostId: postId }, data: { scheduledPostId: null } });
  await tx.triggerCampaign.updateMany({ where: { scheduledPostId: postId }, data: { scheduledPostId: null } });
}

/**
 * Park a campaign on the post. `null` detaches. A campaign must belong to
 * the same workspace (else 404) and the same Instagram account (else 400).
 */
export async function attachCampaignToPost(workspaceId: string, postId: string, link: CampaignLink | null): Promise<void> {
  const post = await loadPost(workspaceId, postId);
  if (!link || (!link.automationId && !link.triggerCampaignId)) {
    await detachAll(prisma, postId);
    return;
  }
  if (link.automationId) {
    const automation = await prisma.automation.findUnique({ where: { id: link.automationId } });
    if (!automation || automation.workspaceId !== workspaceId) throw notFound("Kampaniya topilmadi");
    if (automation.instagramAccountId !== post.instagramAccountId) throw new ContentError(400, "Kampaniya boshqa Instagram akkauntga tegishli");
    await prisma.automation.updateMany({ where: { scheduledPostId: postId, id: { not: automation.id } }, data: { scheduledPostId: null } });
    await prisma.automation.update({
      where: { id: automation.id },
      data: { scheduledPostId: postId, isActive: false, postId: null, pendingNextReel: false },
    });
  }
  if (link.triggerCampaignId) {
    const campaign = await prisma.triggerCampaign.findUnique({ where: { id: link.triggerCampaignId } });
    if (!campaign || campaign.workspaceId !== workspaceId) throw notFound("Kampaniya topilmadi");
    if (campaign.instagramAccountId !== post.instagramAccountId) throw new ContentError(400, "Kampaniya boshqa Instagram akkauntga tegishli");
    await prisma.triggerCampaign.updateMany({ where: { scheduledPostId: postId, id: { not: campaign.id } }, data: { scheduledPostId: null } });
    await prisma.triggerCampaign.update({
      where: { id: campaign.id },
      data: { scheduledPostId: postId, active: false, mediaScope: "SPECIFIC", mediaIds: [] },
    });
  }
}

/** Inside the publish transaction (FR-L3): bind the media id and switch the campaigns on. */
export async function activateLinkedCampaigns(tx: Tx, postId: string, igMediaId: string): Promise<{ automations: number; triggers: number }> {
  const automations = await tx.automation.updateMany({
    where: { scheduledPostId: postId },
    data: { postId: igMediaId, isActive: true, pendingNextReel: false, matchAnyPost: false },
  });
  const triggers = await tx.triggerCampaign.updateMany({
    where: { scheduledPostId: postId },
    data: { mediaIds: [igMediaId], mediaScope: "SPECIFIC", active: true },
  });
  return { automations: automations.count, triggers: triggers.count };
}

/** FR-L4: the post will not go out — the campaign stays linked but silent. */
export async function pauseLinkedCampaigns(postId: string): Promise<void> {
  await prisma.automation.updateMany({ where: { scheduledPostId: postId }, data: { isActive: false } });
  await prisma.triggerCampaign.updateMany({ where: { scheduledPostId: postId }, data: { active: false } });
}

export async function linkedCampaignSummary(postId: string): Promise<LinkedCampaignSummary | null> {
  const automation = await prisma.automation.findFirst({ where: { scheduledPostId: postId }, select: { id: true, name: true, keywords: true, isActive: true, postId: true } });
  if (automation) {
    return { kind: "automation", id: automation.id, name: automation.name, keywords: automation.keywords, active: automation.isActive, waiting: !automation.postId };
  }
  const trigger = await prisma.triggerCampaign.findFirst({ where: { scheduledPostId: postId }, select: { id: true, name: true, keywords: true, active: true, mediaIds: true } });
  if (trigger) {
    return { kind: "trigger", id: trigger.id, name: trigger.name, keywords: trigger.keywords, active: trigger.active, waiting: trigger.mediaIds.length === 0 };
  }
  return null;
}

/** FR-L5: does the caption tell people what to comment? */
export function captionMentionsKeyword(caption: string | null | undefined, keywords: readonly string[]): boolean {
  if (!caption) return false;
  const text = caption.toLowerCase();
  return keywords.some((k) => k.trim() && text.includes(k.trim().toLowerCase()));
}
