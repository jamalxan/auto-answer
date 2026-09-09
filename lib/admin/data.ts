import { prisma } from "@/lib/db/client";

export const ADMIN_PAGE_SIZE = 20;

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
  isSuspended: boolean;
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
  // Count of workspaces matching the current search, for pagination — not
  // the same as totalWorkspaces once a query narrows the result.
  matchingWorkspaces: number;
  page: number;
  pageCount: number;
}

export interface AdminOverviewOptions {
  /** Filters the workspace table by workspace name or owner email. */
  query?: string;
  /** 1-indexed. */
  page?: number;
}

/**
 * Cross-workspace snapshot for the platform-admin panel. The top-line stats
 * are always computed over every workspace; only the workspace table itself
 * is filtered and paginated by `options`.
 */
export async function getAdminOverview(
  options: AdminOverviewOptions = {}
): Promise<AdminOverview> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const query = options.query?.trim();
  const page = Math.max(1, options.page ?? 1);

  const where = query
    ? {
        OR: [
          { name: { contains: query, mode: "insensitive" as const } },
          { owner: { email: { contains: query, mode: "insensitive" as const } } },
        ],
      }
    : undefined;

  const [
    totalWorkspaces,
    totalUsers,
    totalInstagramAccounts,
    totalAutomations,
    activeAutomations,
    dmsSentAllTime,
    dmsSentLast30Days,
    newWorkspacesLast30Days,
    matchingWorkspaces,
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
    prisma.workspace.count({ where }),
    prisma.workspace.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * ADMIN_PAGE_SIZE,
      take: ADMIN_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        createdAt: true,
        dmsSentThisPeriod: true,
        isSuspended: true,
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
  // separately, scoped to just the page of workspaces being rendered.
  const dmsSentByWorkspace = await prisma.dmLog.groupBy({
    by: ["workspaceId"],
    where: { status: "SENT", workspaceId: { in: workspaces.map((w) => w.id) } },
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
    matchingWorkspaces,
    page,
    pageCount: Math.max(1, Math.ceil(matchingWorkspaces / ADMIN_PAGE_SIZE)),
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
      isSuspended: w.isSuspended,
    })),
  };
}
