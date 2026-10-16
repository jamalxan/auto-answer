/**
 * Single source for "undelivered leads" (B-32).
 *
 * The dashboard card, the Diagnostics list and the Integrations page used to
 * count different things (dead only / dead + held / pending incl. test leads),
 * so one waiting lead showed as 1, 0 and "Yetkazilmagan lid yo'q" at once.
 * They all read this now.
 *
 * Definitions (real leads only, test leads never count):
 *   dead     delivery gave up (status DEAD)
 *   held     PENDING / FAILED on an integration that is BROKEN: nothing will
 *            retry it until the integration is repaired
 *   waiting  PENDING / FAILED on any integration (held + normal retries): the
 *            per-integration "kutilmoqda" badge
 *   undeliveredLeads = distinct leads with at least one dead or held delivery
 */

import { prisma } from "@/lib/db/client";

const SCAN_LIMIT = 5000;

export interface DeliveryRow {
  id: string;
  leadId: string;
  integrationId: string;
  status: "PENDING" | "SENT" | "FAILED" | "DEAD";
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
  integration: { name: string; type: string; status: string };
  lead: { name: string | null; phoneE164: string | null };
}

export interface DeliverySummary {
  /** Distinct leads with a dead or held delivery: the one "undelivered" number. */
  undeliveredLeads: number;
  dead: number;
  held: number;
  waitingByIntegration: Map<string, number>;
  deadByIntegration: Map<string, number>;
  /** Newest first: dead, held and retrying rows, for the diagnostics list. */
  rows: DeliveryRow[];
}

export function summarizeDeliveries(rows: DeliveryRow[]): DeliverySummary {
  const leads = new Set<string>();
  const waitingByIntegration = new Map<string, number>();
  const deadByIntegration = new Map<string, number>();
  let dead = 0;
  let held = 0;
  const listed: DeliveryRow[] = [];

  for (const row of rows) {
    if (row.status === "SENT") continue;
    const isDead = row.status === "DEAD";
    const isHeld = !isDead && row.integration.status === "BROKEN";
    if (isDead) {
      dead++;
      deadByIntegration.set(row.integrationId, (deadByIntegration.get(row.integrationId) ?? 0) + 1);
    } else {
      waitingByIntegration.set(row.integrationId, (waitingByIntegration.get(row.integrationId) ?? 0) + 1);
    }
    if (isHeld) held++;
    if (isDead || isHeld) leads.add(row.leadId);
    listed.push(row);
  }

  listed.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return { undeliveredLeads: leads.size, dead, held, waitingByIntegration, deadByIntegration, rows: listed };
}

export async function loadDeliverySummary(workspaceId: string): Promise<DeliverySummary> {
  const rows = (await prisma.leadDelivery.findMany({
    where: {
      lead: { workspaceId, isTest: false },
      status: { in: ["PENDING", "FAILED", "DEAD"] },
    },
    orderBy: { updatedAt: "desc" },
    take: SCAN_LIMIT,
    select: {
      id: true,
      leadId: true,
      integrationId: true,
      status: true,
      attempts: true,
      lastError: true,
      updatedAt: true,
      integration: { select: { name: true, type: true, status: true } },
      lead: { select: { name: true, phoneE164: true } },
    },
  })) as DeliveryRow[];
  return summarizeDeliveries(rows);
}
