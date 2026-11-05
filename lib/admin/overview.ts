import { prisma } from "@/lib/db/client";

/**
 * Platform-admin read models: the overview (business, networks, activity,
 * health) and one workspace's detail. Every network counts the same here:
 * Instagram accounts come from `InstagramAccount`, the others from
 * `ChannelCredential`, and both land in one `NetworkCount` list.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The platform's home timezone: daily buckets follow the owner's calendar. */
const ADMIN_TZ = "Asia/Tashkent";
export const ACTIVITY_DAYS = 30;

export const NETWORKS = ["instagram", "facebook", "threads", "youtube", "telegram"] as const;
export type Network = (typeof NETWORKS)[number];

export interface NetworkCount {
  network: Network;
  connected: number;
  /** Broken token, revoked or erroring credential: needs the customer's reconnect. */
  broken: number;
}

export interface Trend {
  current: number;
  previous: number;
}

export interface DayPoint {
  /** yyyy-mm-dd in ADMIN_TZ. */
  day: string;
  dms: number;
  signups: number;
}

export interface AdminEventRow {
  id: string;
  level: string;
  source: string;
  message: string;
  createdAt: Date;
  workspaceId: string | null;
  workspaceName: string | null;
}

export interface AdminOverview {
  generatedAt: Date;
  workspaces: { total: number; suspended: number; paying: number; newLast30: Trend };
  users: number;
  /** Paid payments, so'm (amountTiyin / 100). */
  revenueLast30: Trend;
  dmsLast30: Trend;
  postsLast30: Trend;
  activeCampaigns: number;
  plans: Array<{ slug: string; count: number }>;
  networks: NetworkCount[];
  daily: DayPoint[];
  health: {
    failedDms24h: number;
    failedPosts7d: number;
    errors24h: number;
    brokenAccounts: number;
  };
  recentErrors: AdminEventRow[];
  recentWorkspaces: Array<{ id: string; name: string; ownerEmail: string | null; createdAt: Date; planSlug: string; isSuspended: boolean }>;
}

function trend(current: number, previous: number): Trend {
  return { current, previous };
}

/** Days from `from` (inclusive) to today in ADMIN_TZ, oldest first. */
export function dayKeys(now: Date, days: number): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: ADMIN_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(fmt.format(new Date(now.getTime() - i * DAY_MS)));
  return keys;
}

/** A paid plan is one that is not the free Start and has not expired. */
function payingWhere(now: Date) {
  return { planSlug: { not: "start" }, OR: [{ planExpiresAt: null }, { planExpiresAt: { gt: now } }] };
}

async function networkCounts(workspaceId?: string): Promise<NetworkCount[]> {
  const ws = workspaceId ? { workspaceId } : {};
  const [igTotal, igBroken, creds] = await Promise.all([
    prisma.instagramAccount.count({ where: ws }),
    prisma.instagramAccount.count({ where: { ...ws, tokenStatus: "BROKEN" } }),
    prisma.channelCredential.groupBy({ by: ["channel", "status"], where: ws, _count: { _all: true } }),
  ]);
  return NETWORKS.map((network) => {
    if (network === "instagram") {
      // An Instagram account may also hold a ChannelCredential; the account table is the record.
      return { network, connected: igTotal, broken: igBroken };
    }
    const rows = creds.filter((c) => c.channel === network);
    const sum = (pred: (s: string) => boolean) => rows.filter((r) => pred(r.status)).reduce((n, r) => n + r._count._all, 0);
    return { network, connected: sum(() => true), broken: sum((s) => s === "REVOKED" || s === "ERROR") };
  });
}

async function dailySeries(now: Date): Promise<DayPoint[]> {
  const keys = dayKeys(now, ACTIVITY_DAYS);
  const from = new Date(now.getTime() - ACTIVITY_DAYS * DAY_MS);
  const [dms, signups] = await Promise.all([
    prisma.$queryRaw<Array<{ day: string; n: number }>>`
      SELECT to_char(("dmSentAt" AT TIME ZONE 'UTC') AT TIME ZONE ${ADMIN_TZ}, 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM "DmLog" WHERE status = 'SENT' AND "dmSentAt" >= ${from}
      GROUP BY 1`,
    prisma.$queryRaw<Array<{ day: string; n: number }>>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${ADMIN_TZ}, 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM "Workspace" WHERE "createdAt" >= ${from}
      GROUP BY 1`,
  ]);
  const dmMap = new Map(dms.map((r) => [r.day, Number(r.n)]));
  const suMap = new Map(signups.map((r) => [r.day, Number(r.n)]));
  return keys.map((day) => ({ day, dms: dmMap.get(day) ?? 0, signups: suMap.get(day) ?? 0 }));
}

async function recentErrors(workspaceId?: string, take = 6): Promise<AdminEventRow[]> {
  const rows = await prisma.operationalEvent.findMany({
    where: { level: "ERROR", resolvedAt: null, ...(workspaceId ? { workspaceId } : {}) },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, level: true, source: true, message: true, createdAt: true, workspaceId: true, workspace: { select: { name: true } } },
  });
  return rows.map((r) => ({ id: r.id, level: r.level, source: r.source, message: r.message, createdAt: r.createdAt, workspaceId: r.workspaceId, workspaceName: r.workspace?.name ?? null }));
}

async function paidSum(from: Date, to: Date, workspaceId?: string): Promise<number> {
  const r = await prisma.payment.aggregate({
    where: { status: "PAID", performedAt: { gte: from, lt: to }, ...(workspaceId ? { workspaceId } : {}) },
    _sum: { amountTiyin: true },
  });
  return Math.round((r._sum.amountTiyin ?? 0) / 100);
}

export async function getAdminOverview(now: Date = new Date()): Promise<AdminOverview> {
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const d60 = new Date(now.getTime() - 60 * DAY_MS);
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d1 = new Date(now.getTime() - DAY_MS);

  const [
    total,
    suspended,
    paying,
    new30,
    newPrev,
    users,
    rev30,
    revPrev,
    dms30,
    dmsPrev,
    posts30,
    postsPrev,
    activeCampaigns,
    plans,
    networks,
    daily,
    failedDms24h,
    failedPosts7d,
    errors24h,
    errors,
    recent,
  ] = await Promise.all([
    prisma.workspace.count(),
    prisma.workspace.count({ where: { isSuspended: true } }),
    prisma.workspace.count({ where: payingWhere(now) }),
    prisma.workspace.count({ where: { createdAt: { gte: d30 } } }),
    prisma.workspace.count({ where: { createdAt: { gte: d60, lt: d30 } } }),
    prisma.user.count(),
    paidSum(d30, now),
    paidSum(d60, d30),
    prisma.dmLog.count({ where: { status: "SENT", dmSentAt: { gte: d30 } } }),
    prisma.dmLog.count({ where: { status: "SENT", dmSentAt: { gte: d60, lt: d30 } } }),
    prisma.scheduledPost.count({ where: { status: { in: ["PUBLISHED", "PUBLISHED_MANUAL"] }, publishedAt: { gte: d30 } } }),
    prisma.scheduledPost.count({ where: { status: { in: ["PUBLISHED", "PUBLISHED_MANUAL"] }, publishedAt: { gte: d60, lt: d30 } } }),
    prisma.automation.count({ where: { isActive: true } }),
    prisma.workspace.groupBy({ by: ["planSlug"], _count: { _all: true } }),
    networkCounts(),
    dailySeries(now),
    prisma.dmLog.count({ where: { status: "FAILED", createdAt: { gte: d1 } } }),
    prisma.scheduledPost.count({ where: { status: "FAILED", updatedAt: { gte: d7 }, deletedAt: null } }),
    prisma.operationalEvent.count({ where: { level: "ERROR", createdAt: { gte: d1 } } }),
    recentErrors(),
    prisma.workspace.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, name: true, createdAt: true, planSlug: true, isSuspended: true, owner: { select: { email: true } } },
    }),
  ]);

  return {
    generatedAt: now,
    workspaces: { total, suspended, paying, newLast30: trend(new30, newPrev) },
    users,
    revenueLast30: trend(rev30, revPrev),
    dmsLast30: trend(dms30, dmsPrev),
    postsLast30: trend(posts30, postsPrev),
    activeCampaigns,
    plans: plans.map((p) => ({ slug: p.planSlug, count: p._count._all })).sort((a, b) => b.count - a.count),
    networks,
    daily,
    health: { failedDms24h, failedPosts7d, errors24h, brokenAccounts: networks.reduce((n, x) => n + x.broken, 0) },
    recentErrors: errors,
    recentWorkspaces: recent.map((w) => ({ id: w.id, name: w.name, ownerEmail: w.owner?.email ?? null, createdAt: w.createdAt, planSlug: w.planSlug, isSuspended: w.isSuspended })),
  };
}

// ─── one workspace ──────────────────────────────────────────────────────────

export interface AdminAccountRow {
  network: Network;
  label: string;
  ok: boolean;
  connectedAt: Date;
}

export interface AdminWorkspaceDetail {
  id: string;
  name: string;
  createdAt: Date;
  planSlug: string;
  planExpiresAt: Date | null;
  isSuspended: boolean;
  suspendedAt: Date | null;
  owner: { email: string | null; name: string | null };
  members: Array<{ email: string | null; name: string | null; role: string; joinedAt: Date }>;
  accounts: AdminAccountRow[];
  networks: NetworkCount[];
  stats: { dmsLast30: number; dmsAllTime: number; activeCampaigns: number; campaigns: number; postsLast30: number; scheduledPosts: number };
  payments: Array<{ id: string; plan: string; months: number; amount: number; provider: string; status: string; createdAt: Date }>;
  revenueAllTime: number;
  errors: AdminEventRow[];
}

export async function getAdminWorkspaceDetail(id: string, now: Date = new Date()): Promise<AdminWorkspaceDetail | null> {
  const ws = await prisma.workspace.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      planSlug: true,
      planExpiresAt: true,
      isSuspended: true,
      suspendedAt: true,
      owner: { select: { email: true, name: true } },
      members: { select: { role: true, createdAt: true, user: { select: { email: true, name: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!ws) return null;
  const d30 = new Date(now.getTime() - 30 * DAY_MS);

  const [igAccounts, creds, networks, dmsLast30, dmsAllTime, activeCampaigns, campaigns, postsLast30, scheduledPosts, payments, revenueAllTime, errors] = await Promise.all([
    prisma.instagramAccount.findMany({ where: { workspaceId: id }, select: { username: true, tokenStatus: true, connectedAt: true } }),
    prisma.channelCredential.findMany({ where: { workspaceId: id, channel: { not: "instagram" } }, select: { channel: true, label: true, externalAccountId: true, status: true, createdAt: true } }),
    networkCounts(id),
    prisma.dmLog.count({ where: { workspaceId: id, status: "SENT", dmSentAt: { gte: d30 } } }),
    prisma.dmLog.count({ where: { workspaceId: id, status: "SENT" } }),
    prisma.automation.count({ where: { workspaceId: id, isActive: true } }),
    prisma.automation.count({ where: { workspaceId: id } }),
    prisma.scheduledPost.count({ where: { workspaceId: id, status: { in: ["PUBLISHED", "PUBLISHED_MANUAL"] }, publishedAt: { gte: d30 } } }),
    prisma.scheduledPost.count({ where: { workspaceId: id, status: "SCHEDULED", deletedAt: null } }),
    prisma.payment.findMany({ where: { workspaceId: id }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, plan: true, months: true, amountTiyin: true, provider: true, status: true, createdAt: true } }),
    paidSum(new Date(0), now, id),
    recentErrors(id, 8),
  ]);

  const accounts: AdminAccountRow[] = [
    ...igAccounts.map((a) => ({ network: "instagram" as const, label: `@${a.username}`, ok: a.tokenStatus === "ACTIVE", connectedAt: a.connectedAt })),
    ...creds
      .filter((c): c is typeof c & { channel: Network } => (NETWORKS as readonly string[]).includes(c.channel))
      .map((c) => ({ network: c.channel, label: c.label ?? c.externalAccountId, ok: c.status === "ACTIVE" || c.status === "EXPIRING", connectedAt: c.createdAt })),
  ];

  return {
    id: ws.id,
    name: ws.name,
    createdAt: ws.createdAt,
    planSlug: ws.planSlug,
    planExpiresAt: ws.planExpiresAt,
    isSuspended: ws.isSuspended,
    suspendedAt: ws.suspendedAt,
    owner: { email: ws.owner?.email ?? null, name: ws.owner?.name ?? null },
    members: ws.members.map((m) => ({ email: m.user.email, name: m.user.name, role: String(m.role), joinedAt: m.createdAt })),
    accounts,
    networks,
    stats: { dmsLast30, dmsAllTime, activeCampaigns, campaigns, postsLast30, scheduledPosts },
    payments: payments.map((p) => ({ id: p.id, plan: p.plan, months: p.months, amount: Math.round(p.amountTiyin / 100), provider: p.provider, status: p.status, createdAt: p.createdAt })),
    revenueAllTime,
    errors,
  };
}
