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

export interface AdminStats {
  totalWorkspaces: number;
  totalUsers: number;
  totalInstagramAccounts: number;
  totalAutomations: number;
  activeAutomations: number;
  dmsSentAllTime: number;
  dmsSentLast30Days: number;
  newWorkspacesLast30Days: number;
}

export interface AdminWorkspacesPage {
  workspaces: AdminWorkspaceRow[];
  // Count of workspaces matching the current search, for pagination.
  matchingWorkspaces: number;
  page: number;
  pageCount: number;
}

/** Cross-workspace aggregate counts — the platform-admin Stats page. */
export async function getAdminStats(): Promise<AdminStats> {
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
  ]);

  return {
    totalWorkspaces,
    totalUsers,
    totalInstagramAccounts,
    totalAutomations,
    activeAutomations,
    dmsSentAllTime,
    dmsSentLast30Days,
    newWorkspacesLast30Days,
  };
}

export interface AdminWorkspacesOptions {
  /** Filters by workspace name or owner email. */
  query?: string;
  /** 1-indexed. */
  page?: number;
}

/** The searchable, paginated workspace table — the platform-admin Workspaces page. */
export async function getAdminWorkspaces(
  options: AdminWorkspacesOptions = {}
): Promise<AdminWorkspacesPage> {
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

  const [matchingWorkspaces, workspaces] = await Promise.all([
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
