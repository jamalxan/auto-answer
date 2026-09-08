import { prisma } from "@/lib/db/client";

export interface AdminWorkspaceRow {
  id: string;
  name: string;
  ownerEmail: string | null;
  createdAt: Date;
  memberCount: number;
  instagramAccountCount: number;
  automationCount: number;
  activeAutomationCount: number;
  dmsSentAllTime: number;
  dmsSentThisPeriod: number;
  lastDmAt: Date | null;
}

export interface AdminOverview {
  totalWorkspaces: number;
  totalUsers: number;
  totalInstagramAccounts: number;
  totalAutomations: number;
  activeAutomations: number;
  dmsSentAllTime: number;
  dmsSentLast30Days: number;
  newWorkspacesLast30Days: number;
  workspaces: AdminWorkspaceRow[];
}

/**
 * Cross-workspace snapshot for the platform-admin panel. Runs a handful of
 * aggregate queries rather than loading every row — fine at this scale, but
 * revisit with real pagination if the workspace count grows into the
 * thousands.
 */
export async function getAdminOverview(): Promise<AdminOverview> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalWorkspaces,
    totalUsers,
    totalInstagramAccounts,
    totalAutomations,
    activeAutomations,
    dmsSentAllTime,
    dmsSentLast30Days,
    newWorkspacesLast30Days,
    workspaces,
  ] = await Promise.all([
    prisma.workspace.count(),
    prisma.user.count(),
    prisma.instagramAccount.count(),
    prisma.automation.count(),
    prisma.automation.count({ where: { isActive: true } }),
    prisma.dmLog.count({ where: { status: "SENT" } }),
    prisma.dmLog.count({
      where: { status: "SENT", dmSentAt: { gte: thirtyDaysAgo } },
    }),
    prisma.workspace.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.workspace.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        createdAt: true,
        dmsSentThisPeriod: true,
        owner: { select: { email: true } },
        _count: {
          select: {
            members: true,
            instagramAccounts: true,
            automations: true,
          },
        },
        automations: {
          select: { isActive: true },
        },
        dmLogs: {
          where: { status: "SENT" },
          select: { dmSentAt: true },
          orderBy: { dmSentAt: "desc" },
          take: 1,
        },
      },
    }),
  ]);

  // dmsSentAllTime per workspace isn't a stored column, so it's counted
  // separately per workspace rather than joined above.
  const dmsSentByWorkspace = await prisma.dmLog.groupBy({
    by: ["workspaceId"],
    where: { status: "SENT" },
    _count: { _all: true },
  });
  const dmsSentMap = new Map(
    dmsSentByWorkspace.map((row) => [row.workspaceId, row._count._all])
  );

  return {
    totalWorkspaces,
    totalUsers,
    totalInstagramAccounts,
    totalAutomations,
    activeAutomations,
    dmsSentAllTime,
    dmsSentLast30Days,
    newWorkspacesLast30Days,
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      ownerEmail: w.owner?.email ?? null,
      createdAt: w.createdAt,
      memberCount: w._count.members,
      instagramAccountCount: w._count.instagramAccounts,
      automationCount: w._count.automations,
      activeAutomationCount: w.automations.filter((a) => a.isActive).length,
      dmsSentAllTime: dmsSentMap.get(w.id) ?? 0,
      dmsSentThisPeriod: w.dmsSentThisPeriod,
      lastDmAt: w.dmLogs[0]?.dmSentAt ?? null,
    })),
  };
}
