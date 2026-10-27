/**
 * Plan limits in use (audit phase 8). Every check returns or throws only
 * when BILLING_ENFORCED=1; otherwise it reports usage and allows.
 *
 *   channels          connect of a NEW channel (reconnects are free)
 *   aiReplies         assistant / JavobAI conversation quota (profile.ts)
 *   aiAuto            trust ladder AUTO
 *   scheduledPosts    posts scheduled this month (Content Scheduler)
 *   videoAnalyses     content-intel analyses this month
 */

import { prisma } from "@/lib/db/client";
import { billingEnforced, effectivePlan, type Plan } from "./plans";

export class PlanLimitError extends Error {
  readonly status = 402;
  constructor(
    readonly limit: keyof Plan["limits"],
    message: string
  ) {
    super(message);
    this.name = "PlanLimitError";
  }
}

export async function workspacePlan(workspaceId: string, now = new Date()): Promise<Plan> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { planSlug: true, planExpiresAt: true } });
  return effectivePlan(workspace ?? {}, now);
}

const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Every connected channel of the workspace, whatever the platform. */
export async function channelsInUse(workspaceId: string): Promise<number> {
  const [instagram, vault, telegram] = await Promise.all([
    prisma.instagramAccount.count({ where: { workspaceId } }),
    prisma.channelCredential.count({ where: { workspaceId, channel: { in: ["facebook", "threads", "youtube"] }, status: { not: "REVOKED" } } }),
    prisma.telegramChannel.count({ where: { workspaceId, status: { not: "REMOVED" } } }),
  ]);
  return instagram + vault + telegram;
}

export interface Usage {
  plan: Plan;
  enforced: boolean;
  channels: number;
  aiReplies: number;
  scheduledPosts: number;
  videoAnalyses: number;
}

export async function workspaceUsage(workspaceId: string, now = new Date()): Promise<Usage> {
  const plan = await workspacePlan(workspaceId, now);
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { aiConversationsThisPeriod: true } });
  const [channels, scheduledPosts, videoAnalyses] = await Promise.all([
    channelsInUse(workspaceId),
    scheduledThisMonth(workspaceId, now),
    prisma.contentAnalysis.count({ where: { workspaceId, status: { in: ["DONE", "PENDING"] }, createdAt: { gte: monthStart(now) } } }),
  ]);
  return { plan, enforced: billingEnforced(), channels, aiReplies: workspace?.aiConversationsThisPeriod ?? 0, scheduledPosts, videoAnalyses };
}

/** Throws when `adding` new channels would pass the plan's channel count. */
export async function assertChannelSlots(workspaceId: string, adding = 1): Promise<void> {
  if (!billingEnforced() || adding <= 0) return;
  const plan = await workspacePlan(workspaceId);
  const used = await channelsInUse(workspaceId);
  if (used + adding > plan.limits.channels) {
    throw new PlanLimitError("channels", `${plan.name} tarifida ${plan.limits.channels} ta kanal — yangi kanal ulash uchun tarifni oshiring`);
  }
}

export async function scheduledThisMonth(workspaceId: string, now = new Date()): Promise<number> {
  return prisma.scheduledPost.count({ where: { workspaceId, deletedAt: null, scheduledAt: { gte: monthStart(now) }, status: { notIn: ["DRAFT", "CANCELED"] } } });
}

/** Scheduling one more post this month (rescheduling an already scheduled one is free). */
export async function assertCanSchedule(workspaceId: string, alreadyCounted: boolean, now = new Date()): Promise<void> {
  if (!billingEnforced() || alreadyCounted) return;
  const plan = await workspacePlan(workspaceId, now);
  if ((await scheduledThisMonth(workspaceId, now)) >= plan.limits.scheduledPostsPerMonth) {
    throw new PlanLimitError("scheduledPostsPerMonth", `${plan.name} tarifida oyiga ${plan.limits.scheduledPostsPerMonth} ta rejalashtirilgan post — tarifni oshiring`);
  }
}

export async function assertAiAuto(workspaceId: string): Promise<void> {
  if (!billingEnforced()) return;
  const plan = await workspacePlan(workspaceId);
  if (!plan.limits.aiAuto) throw new PlanLimitError("aiAuto", `${plan.name} tarifida AI faqat kuzatish va copilot rejimida — avto rejim Biznes tarifidan`);
}

/** null = no plan cap (billing not enforced): the env default applies. */
export async function videoAnalysisCap(workspaceId: string): Promise<number | null> {
  if (!billingEnforced()) return null;
  return (await workspacePlan(workspaceId)).limits.videoAnalysesPerMonth;
}
