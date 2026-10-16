/**
 * ETAP 9.4 — badges by points threshold. Each badge is awarded once per
 * contact (`@@unique(contactId, badgeKey)`), with a "Nishon: …" NOTE on the
 * CRM timeline. Thresholds come from the workspace settings (defaults below).
 */

import { prisma } from "@/lib/db/client";
import { recordActivity } from "@/lib/crm/activity";
import { isUniqueViolation } from "@/lib/crm/errors";
import { DEFAULT_BADGES, getSettings, type BadgeRule } from "./settings";

export { DEFAULT_BADGES };
export type { BadgeRule };

/** Total points of a contact: one SUM in the database (index: workspaceId, contactId), no rows loaded. */
export async function pointsOf(workspaceId: string, contactId: string): Promise<number> {
  const total = await prisma.engagementPoint.aggregate({ where: { workspaceId, contactId }, _sum: { points: true } });
  return total._sum.points ?? 0;
}

/** Awards every badge whose threshold the contact reached and does not have yet. Returns the new keys. */
export async function checkBadges(workspaceId: string, contactId: string, now: Date = new Date()): Promise<string[]> {
  const total = await pointsOf(workspaceId, contactId);
  const { badgeRules } = await getSettings(workspaceId);
  const due = badgeRules.filter((badge) => total >= badge.threshold);
  if (due.length === 0) return [];

  const have = await prisma.engagementBadge.findMany({ where: { workspaceId, contactId }, select: { badgeKey: true } });
  const owned = new Set(have.map((row) => row.badgeKey));
  const awarded: string[] = [];
  for (const badge of due) {
    if (owned.has(badge.key)) continue;
    let row;
    try {
      row = await prisma.engagementBadge.create({ data: { workspaceId, contactId, badgeKey: badge.key, awardedAt: now } });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
    awarded.push(badge.key);
    await recordActivity({
      workspaceId,
      contactId,
      type: "NOTE",
      occurredAt: now,
      actorKind: "AUTOMATION",
      title: `Nishon: ${badge.name}`,
      body: `${total} ball to'plandi (chegara: ${badge.threshold}).`,
      payload: { badgeKey: badge.key, badgeName: badge.name, points: total },
      sourceTable: "EngagementBadge",
      sourceId: row.id,
    });
  }
  return awarded;
}

/** Badges of a contact, with names from the settings. */
export async function badgesOf(workspaceId: string, contactId: string): Promise<Array<{ key: string; name: string; awardedAt: Date }>> {
  const { badgeRules } = await getSettings(workspaceId);
  const names = new Map(badgeRules.map((badge) => [badge.key, badge.name]));
  const rows = await prisma.engagementBadge.findMany({ where: { workspaceId, contactId }, orderBy: { awardedAt: "asc" } });
  return rows.map((row) => ({ key: row.badgeKey, name: names.get(row.badgeKey) ?? row.badgeKey, awardedAt: row.awardedAt }));
}
