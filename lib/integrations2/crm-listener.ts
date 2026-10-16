/**
 * ETAP 8 — the bus listens to the CRM (lib/crm/hooks registerCrmListener),
 * so lib/crm needs no edits for these two events:
 *
 *   score (becameHot)   → lead.hot            (once per lead; the lead of that contact)
 *   stage_changed       → deal.stage_changed
 *
 * Registered from the worker module (registerIntegrationsModule), like the
 * broadcast attribution listeners. Fire-and-forget: a bus problem is logged
 * and never reaches the CRM sync that emitted the event.
 */

import { registerCrmListener, type CrmEvent } from "@/lib/crm/hooks";
import { prisma } from "@/lib/db/client";
import { isOutboundBusEnabled } from "./config";
import { emitLeadHot, emitOutbound } from "./emit";
import { dedupeKeyFor } from "./events";

export async function handleCrmEvent(event: CrmEvent): Promise<void> {
  if (!isOutboundBusEnabled()) return;

  if (event.kind === "score" && event.becameHot) {
    const contact = event.contact;
    const lead =
      (contact.conversationId
        ? await prisma.lead.findFirst({ where: { workspaceId: event.workspaceId, conversationId: contact.conversationId }, orderBy: { createdAt: "desc" } })
        : null) ??
      (await prisma.lead.findFirst({
        where: { workspaceId: event.workspaceId, instagramAccountId: contact.instagramAccountId, igUserId: contact.igUserId },
        orderBy: { createdAt: "desc" },
      }));
    // No lead yet: lead.created (which fires lead.hot for a HOT lead) covers it later.
    if (lead) await emitLeadHot({ id: lead.id, workspaceId: lead.workspaceId, instagramAccountId: lead.instagramAccountId, isTest: lead.isTest });
    return;
  }

  if (event.kind === "stage_changed") {
    const deal = await prisma.crmDeal.findUnique({ where: { id: event.dealId }, select: { stageEnteredAt: true } });
    const changedAt = deal?.stageEnteredAt ?? new Date();
    await emitOutbound({
      workspaceId: event.workspaceId,
      type: "deal.stage_changed",
      subjectType: "deal",
      subjectId: event.dealId,
      instagramAccountId: event.contact.instagramAccountId,
      payload: { fromStageId: event.fromStageId },
      dedupeKey: dedupeKeyFor("deal.stage_changed", event.dealId, event.toStageId, changedAt),
      occurredAt: changedAt,
    });
  }
}

let unregister: (() => void) | null = null;

/** Idempotent. */
export function registerIntegrationsCrmListeners(): void {
  if (unregister) return;
  unregister = registerCrmListener(handleCrmEvent);
}

/** Tests / hot reload. */
export function unregisterIntegrationsCrmListeners(): void {
  unregister?.();
  unregister = null;
}
