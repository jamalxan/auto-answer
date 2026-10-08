/**
 * Dashboard numbers, shared by GET /api/dashboard/stats (account switcher) and
 * the dashboard page itself, which renders them on the server so the first
 * paint already has data instead of waiting for a second round trip.
 */

import { prisma } from "@/lib/db/client";
import { aiConversationLimit } from "@/lib/assistant/profile";
import {
  calculateCtr,
  normalizeTopKeywords,
  summarizeDmStatuses,
} from "@/lib/tracking/analytics";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getDashboardStats(opts: {
  workspaceId: string;
  userId: string | null;
  locale: string;
  selectedAccountId: string | null;
}) {
  const { workspaceId, userId, locale, selectedAccountId } = opts;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const accountFilter = selectedAccountId ? { instagramAccountId: selectedAccountId } : {};

  // The seven daily buckets of the chart, counted together with everything
  // else instead of one query after another.
  const days = Array.from({ length: 7 }, (_, index) => {
    const dayStart = new Date(todayStart);
    dayStart.setDate(dayStart.getDate() - (6 - index));
    return { dayStart, dayEnd: new Date(dayStart.getTime() + DAY_MS) };
  });

  const [
    workspace,
    instagramAccount,
    instagramAccounts,
    totalAutomations,
    activeAutomations,
    dmsSentToday,
    dmsSentWeek,
    dmsSentMonth,
    totalDMs,
    dmStatusCountsThisMonth,
    clicksThisMonth,
    totalClicks,
    topKeywordRows,
    recentLogs,
    user,
    contactGroups,
    dailyCounts,
  ] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        name: true,
        dmsSentThisPeriod: true,
        aiConversationsThisPeriod: true,
        aiConversationsLimit: true,
      },
    }),
    prisma.instagramAccount.findFirst({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        instagramId: true,
        tokenExpiresAt: true,
        tokenStatus: true,
        webhookSubscribed: true,
      },
    }),
    prisma.instagramAccount.findMany({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: {
        id: true,
        username: true,
        instagramId: true,
        name: true,
        tokenExpiresAt: true,
        tokenStatus: true,
        webhookSubscribed: true,
      },
    }),
    prisma.automation.count({ where: { workspaceId, ...accountFilter } }),
    prisma.automation.count({ where: { workspaceId, isActive: true, ...accountFilter } }),
    prisma.dmLog.count({
      where: { workspaceId, status: "SENT", createdAt: { gte: todayStart }, ...accountFilter },
    }),
    prisma.dmLog.count({
      where: { workspaceId, status: "SENT", createdAt: { gte: weekStart }, ...accountFilter },
    }),
    prisma.dmLog.count({
      where: { workspaceId, status: "SENT", createdAt: { gte: monthStart }, ...accountFilter },
    }),
    prisma.dmLog.count({ where: { workspaceId, status: "SENT", ...accountFilter } }),
    prisma.dmLog.groupBy({
      by: ["status"],
      where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter },
      _count: { _all: true },
    }),
    prisma.linkClick.count({
      where: { workspaceId, createdAt: { gte: monthStart }, ...accountFilter },
    }),
    prisma.linkClick.count({ where: { workspaceId, ...accountFilter } }),
    prisma.dmLog.groupBy({
      by: ["matchedKeyword"],
      where: { workspaceId, matchedKeyword: { not: null }, ...accountFilter },
      _count: { _all: true },
    }),
    prisma.dmLog.findMany({
      where: { workspaceId, ...accountFilter },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        automation: { select: { name: true } },
        instagramAccount: { select: { username: true } },
      },
    }),
    userId
      ? prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } })
      : Promise.resolve(null),
    // Distinct people who have interacted, counted as "contacts" — grouped in
    // the database instead of loading one row per DM.
    prisma.dmLog.groupBy({
      by: ["commenterId"],
      where: { workspaceId, ...accountFilter },
    }),
    Promise.all(
      days.map(({ dayStart, dayEnd }) =>
        prisma.dmLog.count({
          where: { workspaceId, status: "SENT", createdAt: { gte: dayStart, lt: dayEnd }, ...accountFilter },
        })
      )
    ),
  ]);

  const dailyDMs = days.map(({ dayStart }, index) => ({
    date: dayStart.toLocaleDateString(locale, { weekday: "short" }),
    count: dailyCounts[index],
  }));

  const monthlyStatusSummary = summarizeDmStatuses(
    dmStatusCountsThisMonth.map((row) => ({ status: row.status, _count: row._count._all }))
  );
  const topKeywords = normalizeTopKeywords(
    topKeywordRows.map((row) => ({ matchedKeyword: row.matchedKeyword, _count: row._count._all }))
  );

  const firstName = user?.name?.trim().split(/\s+/)[0] || user?.email?.split("@")[0] || null;

  return {
    userName: firstName,
    contactsCount: contactGroups.length,
    workspace: workspace ? { ...workspace, aiConversationsLimit: aiConversationLimit(workspace) } : workspace,
    instagramAccount,
    instagramAccounts,
    selectedInstagramAccountId: selectedAccountId,
    totalAutomations,
    activeAutomations,
    dmsSentToday,
    dmsSentWeek,
    dmsSentMonth,
    dmsSkippedMonth: monthlyStatusSummary.skipped,
    dmsFailedMonth: monthlyStatusSummary.failed,
    totalDMs,
    clicksThisMonth,
    totalClicks,
    ctrThisMonth: calculateCtr(clicksThisMonth, dmsSentMonth),
    topKeywords,
    dailyDMs,
    recentLogs,
  };
}

/** The lead cards on the dashboard (last 30 days). */
export async function getLeadCards(workspaceId: string) {
  const since30 = new Date(Date.now() - 30 * DAY_MS);
  const [leads30, assistantChats, capturedWithPhone, dead, held] = await Promise.all([
    prisma.lead.count({ where: { workspaceId, isTest: false, createdAt: { gte: since30 } } }),
    prisma.conversation.count({
      where: { workspaceId, botMessageCount: { gt: 0 }, createdAt: { gte: since30 } },
    }),
    prisma.lead.count({
      where: {
        workspaceId,
        isTest: false,
        phoneE164: { not: null },
        createdAt: { gte: since30 },
        conversation: { botMessageCount: { gt: 0 } },
      },
    }),
    prisma.leadDelivery.count({ where: { lead: { workspaceId, isTest: false }, status: "DEAD" } }),
    prisma.leadDelivery.count({
      where: {
        lead: { workspaceId, isTest: false },
        status: { in: ["PENDING", "FAILED"] },
        integration: { status: "BROKEN" },
      },
    }),
  ]);
  return {
    leads30,
    conversionPct: assistantChats > 0 ? Math.round((capturedWithPhone / assistantChats) * 100) : 0,
    assistantChats,
    undelivered: dead + held,
  };
}

export type DashboardStats = Awaited<ReturnType<typeof getDashboardStats>>;
export type LeadCards = Awaited<ReturnType<typeof getLeadCards>>;
