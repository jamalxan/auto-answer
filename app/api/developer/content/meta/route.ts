import { jsonOk } from "@/lib/api-auth";
import { carouselMaxItems, CONTENT_LIMITS, isContentSchedulerEnabled, maxCollaborators, storageQuotaBytes } from "@/lib/content/config";
import { canContent } from "@/lib/content/permissions";
import { reviewerCandidates } from "@/lib/content/review";
import { getStorageDriverName, isStorageConfigured } from "@/lib/content/storage";
import { prisma } from "@/lib/db/client";
import { requireContent } from "@/lib/developer/content-guard";
import { isTelegramConfigured } from "@/lib/telegram/api";
import { getWorkspaceChats } from "@/lib/telegram/notify";
import { normalizeRole, ROLE_LABELS } from "@/lib/workspace-permissions";

export const dynamic = "force-dynamic";

/** Everything the Content screens need in one call: accounts, campaigns to link, role flags, limits, storage, Telegram. */
export async function GET() {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const { workspaceId, role } = auth.ctx;
  const [accounts, automations, triggerCampaigns, workspace, savedTexts, chats] = await Promise.all([
    prisma.instagramAccount.findMany({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: { id: true, username: true, tokenStatus: true, canPublish: true, accountType: true, publishQuotaUsed: true },
    }),
    prisma.automation.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, name: true, instagramAccountId: true, isActive: true, keywords: true, scheduledPostId: true, postId: true },
    }),
    prisma.triggerCampaign.findMany({
      where: { workspaceId, triggerType: "COMMENT", kind: "CAMPAIGN" },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, name: true, instagramAccountId: true, active: true, keywords: true, scheduledPostId: true, mediaIds: true },
    }),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true, mediaStorageBytes: true } }),
    prisma.savedText.findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, take: 100 }),
    isTelegramConfigured() ? getWorkspaceChats(workspaceId).catch(() => []) : Promise.resolve([]),
  ]);
  // Approval (Faza 2): the members a post can be sent to for review.
  const reviewers = await reviewerCandidates(workspaceId).catch(() => []);
  return jsonOk({
    disabled: !isContentSchedulerEnabled(),
    reviewers,
    me: {
      role,
      normalizedRole: normalizeRole(role),
      roleLabel: ROLE_LABELS[normalizeRole(role)],
      canCreate: canContent(role, "content.create"),
      canSchedule: canContent(role, "content.schedule"),
      canApprove: canContent(role, "content.approve"),
    },
    accounts,
    campaigns: [
      ...automations.map((a) => ({ kind: "automation" as const, id: a.id, name: a.name, instagramAccountId: a.instagramAccountId, active: a.isActive, keywords: a.keywords, linkedPostId: a.scheduledPostId, bound: Boolean(a.postId) })),
      ...triggerCampaigns.map((t) => ({ kind: "trigger" as const, id: t.id, name: t.name, instagramAccountId: t.instagramAccountId, active: t.active, keywords: t.keywords, linkedPostId: t.scheduledPostId, bound: t.mediaIds.length > 0 })),
    ],
    savedTexts,
    timezone: workspace?.timezone ?? "Asia/Tashkent",
    storage: {
      usedBytes: Number(workspace?.mediaStorageBytes ?? 0),
      quotaBytes: storageQuotaBytes(),
      configured: isStorageConfigured(),
      driver: getStorageDriverName(),
    },
    telegramConnected: chats.length > 0,
    limits: {
      ...CONTENT_LIMITS,
      carouselMax: carouselMaxItems(),
      maxCollaborators: maxCollaborators(),
    },
  });
}
