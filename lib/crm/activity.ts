/**
 * ETAP 5.0 — `CrmActivity` rows: timeline events that have no other home
 * (tags, stages, assignments, notes, broadcasts) plus denormalised state
 * changes (score, temperature, handoff, lead). Messages are never copied
 * here; the merged timeline reads them live (lib/crm/timeline.ts).
 *
 * Rows synced from another table carry (sourceTable, sourceId, type) and are
 * idempotent on that key: a retried job or a reconciler pass hitting the
 * unique index is a no-op.
 */

import type { CrmActivity, CrmActivityType, CrmActorKind, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export interface RecordActivityInput {
  workspaceId: string;
  contactId: string;
  dealId?: string | null;
  type: CrmActivityType;
  occurredAt: Date;
  actorKind: CrmActorKind;
  actorMemberId?: string | null;
  /** One line, Uzbek. */
  title: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
  sourceTable?: string | null;
  sourceId?: string | null;
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

function jsonOrNull(value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
  if (!value) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Store one activity. Returns the new row, or null when a row with the same
 * (sourceTable, sourceId, type) already exists.
 */
export async function recordActivity(input: RecordActivityInput): Promise<CrmActivity | null> {
  try {
    return await prisma.crmActivity.create({
      data: {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        dealId: input.dealId ?? null,
        type: input.type,
        occurredAt: input.occurredAt,
        actorKind: input.actorKind,
        actorMemberId: input.actorMemberId ?? null,
        title: input.title.slice(0, 200),
        body: input.body ? input.body.slice(0, 2000) : null,
        payload: jsonOrNull(input.payload),
        sourceTable: input.sourceTable ?? null,
        sourceId: input.sourceId ?? null,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/** Newest first, for the contact card; the merged feed is loadTimeline. */
export async function listActivities(
  workspaceId: string,
  contactId: string,
  options: { before?: Date | null; limit?: number; types?: CrmActivityType[] } = {}
): Promise<CrmActivity[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return prisma.crmActivity.findMany({
    where: {
      workspaceId,
      contactId,
      ...(options.before ? { occurredAt: { lt: options.before } } : {}),
      ...(options.types?.length ? { type: { in: options.types } } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit,
  });
}
