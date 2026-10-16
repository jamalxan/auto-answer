/**
 * ETAP 9.4 — leaderboard and ledger. The ranking is one database GROUP BY
 * contactId with SUM(points), ordered and cut to the requested size
 * (<= MAX_LIMIT rows come back, never the whole ledger); a per-contact total
 * (badges.ts pointsOf) is one SUM too. Periods use Tashkent calendar days:
 * "7d" is today and the six days before it, "30d" today and the 29 before it.
 */

import { prisma } from "@/lib/db/client";
import { tashkentDayStart } from "@/lib/javobai/usage";
import { getSettings } from "./settings";

export type LeaderboardPeriod = "7d" | "30d" | "all";

export interface LeaderboardRow {
  contactId: string;
  username: string | null;
  name: string | null;
  points: number;
  badges: Array<{ key: string; name: string }>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

/** First instant of the period (Tashkent midnight), null for "all". */
export function periodStart(period: LeaderboardPeriod, now: Date = new Date()): Date | null {
  if (period === "all") return null;
  return tashkentDayStart(now, period === "7d" ? 6 : 29);
}

export async function leaderboard(
  workspaceId: string,
  options: { period?: LeaderboardPeriod; limit?: number; now?: Date } = {}
): Promise<LeaderboardRow[]> {
  const period = options.period ?? "all";
  const since = periodStart(period, options.now ?? new Date());
  const groups = await prisma.engagementPoint.groupBy({
    by: ["contactId"],
    where: { workspaceId, ...(since ? { occurredAt: { gte: since } } : {}) },
    _sum: { points: true },
    orderBy: [{ _sum: { points: "desc" } }, { contactId: "asc" }],
    take: clampLimit(options.limit),
  });
  const top = groups
    .map((group) => [group.contactId, group._sum?.points ?? 0] as const)
    .filter(([, points]) => points > 0);
  if (top.length === 0) return [];

  const ids = top.map(([contactId]) => contactId);
  const [contacts, badgeRows, settings] = await Promise.all([
    prisma.crmContact.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, username: true, name: true } }),
    prisma.engagementBadge.findMany({ where: { workspaceId, contactId: { in: ids } }, orderBy: { awardedAt: "asc" } }),
    getSettings(workspaceId),
  ]);
  const byId = new Map(contacts.map((contact) => [contact.id, contact]));
  const names = new Map(settings.badgeRules.map((badge) => [badge.key, badge.name]));
  return top.map(([contactId, points]) => ({
    contactId,
    username: byId.get(contactId)?.username ?? null,
    name: byId.get(contactId)?.name ?? null,
    points,
    badges: badgeRows
      .filter((badge) => badge.contactId === contactId)
      .map((badge) => ({ key: badge.badgeKey, name: names.get(badge.badgeKey) ?? badge.badgeKey })),
  }));
}

export interface LedgerEntry {
  id: string;
  contactId: string;
  points: number;
  reason: string;
  sourceTable: string;
  sourceId: string;
  occurredAt: Date;
}

/** Newest first; `cursor` is the last id of the previous page. */
export async function ledger(
  workspaceId: string,
  options: { contactId?: string; cursor?: string | null; limit?: number } = {}
): Promise<{ items: LedgerEntry[]; nextCursor: string | null }> {
  const limit = clampLimit(options.limit, 50);
  const rows = await prisma.engagementPoint.findMany({
    where: { workspaceId, ...(options.contactId ? { contactId: options.contactId } : {}) },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      contactId: row.contactId,
      points: row.points,
      reason: row.reason,
      sourceTable: row.sourceTable,
      sourceId: row.sourceId,
      occurredAt: row.occurredAt,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}
