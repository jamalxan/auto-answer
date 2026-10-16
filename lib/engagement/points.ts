/**
 * ETAP 9.4 — the points ledger. One row per (sourceTable, sourceId, reason):
 * a replayed event, a retried job or a double listener never adds twice.
 * Every award leaves a NOTE on the CRM timeline and re-checks badges.
 * `awardPoints` never throws: engagement bookkeeping must not break the
 * caller (a CRM listener, a reward, a collector).
 */

import { prisma } from "@/lib/db/client";
import { recordActivity } from "@/lib/crm/activity";
import { isUniqueViolation } from "@/lib/crm/errors";
import { checkBadges } from "./badges";
import { DEFAULT_POINTS_RULES, POINT_REASON_LABELS, getSettings, type PointReason } from "./settings";

export { DEFAULT_POINTS_RULES };
export { pointsOf } from "./badges";

export interface AwardPointsInput {
  workspaceId: string;
  contactId: string;
  reason: string;
  /** Default: the workspace's rule for `reason` (nothing is awarded for a disabled / unknown rule). */
  points?: number;
  sourceTable: string;
  sourceId: string;
  occurredAt?: Date;
}

export interface AwardPointsResult {
  awarded: boolean;
  points: number;
  /** Why nothing was awarded. */
  skipped?: "duplicate" | "disabled" | "zero" | "no_contact" | "error";
  pointId?: string;
}

export async function awardPoints(input: AwardPointsInput): Promise<AwardPointsResult> {
  try {
    const { workspaceId, contactId, reason, sourceTable, sourceId } = input;
    let points = input.points;
    if (points === undefined) {
      const rule = (await getSettings(workspaceId)).pointsRules[reason as PointReason];
      if (!rule || !rule.enabled) return { awarded: false, points: 0, skipped: "disabled" };
      points = rule.points;
    }
    if (!Number.isInteger(points) || points <= 0) return { awarded: false, points: 0, skipped: "zero" };

    const contact = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true } });
    if (!contact) return { awarded: false, points: 0, skipped: "no_contact" };

    const existing = await prisma.engagementPoint.findUnique({ where: { sourceTable_sourceId_reason: { sourceTable, sourceId, reason } } });
    if (existing) return { awarded: false, points: existing.points, skipped: "duplicate", pointId: existing.id };

    const occurredAt = input.occurredAt ?? new Date();
    let row;
    try {
      row = await prisma.engagementPoint.create({ data: { workspaceId, contactId, points, reason, sourceTable, sourceId, occurredAt } });
    } catch (error) {
      if (isUniqueViolation(error)) return { awarded: false, points, skipped: "duplicate" };
      throw error;
    }

    const label = POINT_REASON_LABELS[reason as PointReason] ?? reason;
    await recordActivity({
      workspaceId,
      contactId,
      type: "NOTE",
      occurredAt,
      actorKind: "AUTOMATION",
      title: `Ball: +${points} (${label})`,
      payload: { points, reason, sourceTable, sourceId },
      sourceTable: "EngagementPoint",
      sourceId: row.id,
    }).catch(() => null);
    await checkBadges(workspaceId, contactId, occurredAt).catch((error) => {
      console.error("[Engagement] badge check failed:", error instanceof Error ? error.message : error);
    });
    return { awarded: true, points, pointId: row.id };
  } catch (error) {
    console.error("[Engagement] awardPoints failed:", error instanceof Error ? error.message : error);
    return { awarded: false, points: 0, skipped: "error" };
  }
}
