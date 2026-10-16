/**
 * ETAP 8 — `emitOutbound`: the one call app code makes when something
 * happened that integrations may want to hear about.
 *
 * Fire-and-forget like `crmTouch`: call it as `void emitOutbound(...)` right
 * after the app's own record is written. It inserts one `OutboundEvent`
 * (payload not built yet) and hands a "materialize" job to the worker; the
 * worker freezes the payload and fans out to the subscriptions. It never
 * throws, is a no-op under `INTEGRATIONS_BUS_DISABLED=1` or without Redis,
 * and a repeated `dedupeKey` (retry, redelivery, a second code path) is a
 * silent no-op, so events are emitted at most once.
 *
 * The convenience emitters at the bottom (`emitLeadCreated`, …) are what the
 * production hook sites call: each looks up the little it needs and is
 * equally best-effort.
 */

import { prisma } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/crm/result";
import { MATERIALIZE_DELAY_MS, isOutboundBusEnabled, type OutboundEventType } from "./config";
import { dedupeKeyFor } from "./events";
import { enqueueMaterialize } from "./queue";

export interface EmitInput {
  workspaceId: string;
  type: OutboundEventType;
  subjectType: "lead" | "contact" | "deal" | "handoff" | "broadcast" | "test";
  subjectId: string;
  instagramAccountId?: string | null;
  isTest?: boolean;
  /** Hints for the materialiser (e.g. `{ tag: "vip" }`, `{ fromStageId }`); stored until the payload is frozen. */
  payload?: Record<string, unknown> | null;
  dedupeKey: string;
  occurredAt?: Date;
}

/** Lead events wait for the score insight that is written right after the lead. */
export function isLeadEvent(type: OutboundEventType): boolean {
  return type === "lead.created" || type === "lead.hot" || type === "lead.updated";
}

export function busHasBackend(): boolean {
  return isOutboundBusEnabled() && Boolean(process.env.REDIS_URL?.trim());
}

/** Returns the new event id, or null when nothing was emitted (disabled, duplicate, error). */
export async function emitOutbound(input: EmitInput): Promise<string | null> {
  try {
    if (!busHasBackend()) return null;
    let eventId: string;
    try {
      const event = await prisma.outboundEvent.create({
        data: {
          workspaceId: input.workspaceId,
          type: input.type,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          instagramAccountId: input.instagramAccountId ?? null,
          isTest: input.isTest ?? false,
          payload: input.payload ? JSON.parse(JSON.stringify({ hint: input.payload })) : undefined,
          dedupeKey: input.dedupeKey,
          occurredAt: input.occurredAt ?? new Date(),
        },
        select: { id: true },
      });
      eventId = event.id;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    await enqueueMaterialize(eventId, isLeadEvent(input.type) ? MATERIALIZE_DELAY_MS : 0);
    return eventId;
  } catch (error) {
    console.error("[Integrations] emit skipped:", error instanceof Error ? error.message : error);
    return null;
  }
}

// ─── Hook-site helpers ────────────────────────────────────────────────────────

export async function emitLeadCreated(lead: {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  isTest?: boolean;
}): Promise<void> {
  await emitOutbound({
    workspaceId: lead.workspaceId,
    type: "lead.created",
    subjectType: "lead",
    subjectId: lead.id,
    instagramAccountId: lead.instagramAccountId,
    isTest: lead.isTest ?? false,
    dedupeKey: dedupeKeyFor("lead.created", lead.id),
  });
}

export async function emitLeadHot(lead: {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  isTest?: boolean;
}): Promise<void> {
  await emitOutbound({
    workspaceId: lead.workspaceId,
    type: "lead.hot",
    subjectType: "lead",
    subjectId: lead.id,
    instagramAccountId: lead.instagramAccountId,
    isTest: lead.isTest ?? false,
    dedupeKey: dedupeKeyFor("lead.hot", lead.id),
  });
}

export async function emitHandoffOpened(handoffId: string, conversationId: string): Promise<void> {
  try {
    if (!busHasBackend()) return;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { workspaceId: true, instagramAccountId: true },
    });
    if (!conversation) return;
    await emitOutbound({
      workspaceId: conversation.workspaceId,
      type: "handoff.opened",
      subjectType: "handoff",
      subjectId: handoffId,
      instagramAccountId: conversation.instagramAccountId,
      dedupeKey: dedupeKeyFor("handoff.opened", handoffId),
    });
  } catch (error) {
    console.error("[Integrations] handoff emit skipped:", error instanceof Error ? error.message : error);
  }
}

export async function emitContactTagged(workspaceId: string, contactId: string, slug: string): Promise<void> {
  try {
    if (!busHasBackend()) return;
    const contact = await prisma.crmContact.findFirst({
      where: { id: contactId, workspaceId },
      select: { instagramAccountId: true },
    });
    await emitOutbound({
      workspaceId,
      type: "contact.tagged",
      subjectType: "contact",
      subjectId: contactId,
      instagramAccountId: contact?.instagramAccountId ?? null,
      payload: { tag: slug },
      dedupeKey: dedupeKeyFor("contact.tagged", contactId, slug),
    });
  } catch (error) {
    console.error("[Integrations] tag emit skipped:", error instanceof Error ? error.message : error);
  }
}

export async function emitBroadcastCompleted(broadcastId: string): Promise<void> {
  try {
    if (!busHasBackend()) return;
    const broadcast = await prisma.crmBroadcast.findUnique({
      where: { id: broadcastId },
      select: { workspaceId: true, instagramAccountId: true, completedAt: true },
    });
    if (!broadcast) return;
    await emitOutbound({
      workspaceId: broadcast.workspaceId,
      type: "broadcast.completed",
      subjectType: "broadcast",
      subjectId: broadcastId,
      instagramAccountId: broadcast.instagramAccountId,
      dedupeKey: dedupeKeyFor("broadcast.completed", broadcastId),
      occurredAt: broadcast.completedAt ?? new Date(),
    });
  } catch (error) {
    console.error("[Integrations] broadcast emit skipped:", error instanceof Error ? error.message : error);
  }
}
