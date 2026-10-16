/**
 * ETAP 5.0 — the two seams between the CRM and the rest of the app.
 *
 * 1. `crmTouch(input)` — the fire-and-forget hook the engines call right
 *    after they wrote their own record (customer message stored, operator
 *    reply, AI reply, lead created, Telegram "Bog'lanildi", handoff, score).
 *    It only hands a job to the "crm" queue; the worker (lib/crm/worker.ts →
 *    lib/crm/sync.ts applyCrmTouch) does the reads and writes. It never
 *    throws, never awaits anything but `queue.add`, and is a no-op under
 *    unless `CRM_ENABLED=1` (or with `CRM_DISABLED=1`) or without Redis. The 5-minute reconciler is the
 *    safety net behind it, so a lost job is never a lost contact.
 *
 * 2. `registerCrmListener(fn)` — in-process events the DB layer emits after
 *    a contact changed (interaction, lead, handoff, score, stage). The tag /
 *    assignment / broadcast modules subscribe here instead of editing the
 *    sync code. Listeners run sequentially, each in its own try/catch.
 */

import type { CrmContact } from "@/app/generated/prisma/client";
import type { CrmStageKind, CrmTemperature } from "./types";
import { enqueueCrmTouch, hasCrmQueueBackend, type CrmTouchInput, type CrmTouchKind } from "./queue";

export type { CrmTouchInput, CrmTouchKind } from "./queue";
export { isCrmEnabled } from "./queue";

/**
 * Hand the event to the CRM worker. Safe to call as `void crmTouch(...)` from
 * a hot path: a Redis outage or a bad input is logged, never thrown.
 */
export async function crmTouch(input: CrmTouchInput): Promise<void> {
  try {
    if (!hasCrmQueueBackend()) return;
    await enqueueCrmTouch({ ...input, at: input.at ?? new Date() });
  } catch (error) {
    console.error("[CRM] touch skipped:", error instanceof Error ? error.message : error);
  }
}

// ─── Listener registry ────────────────────────────────────────────────────────

export interface CrmEventBase {
  workspaceId: string;
  contactId: string;
  /** The contact after the change. */
  contact: CrmContact;
}

/** Which hook / sync pass saw an interaction. */
export type CrmInteractionVia = CrmTouchKind | "reconcile" | "backfill";

export type CrmEvent =
  | (CrmEventBase & {
      kind: "interaction";
      direction: "inbound" | "outbound";
      via: CrmInteractionVia;
      conversationId?: string | null;
      /** The operator's WorkspaceMember id for an operator reply, when known. */
      memberId?: string | null;
      at: Date;
      payload?: Record<string, unknown> | null;
    })
  | (CrmEventBase & { kind: "lead_created"; leadId: string; dealId: string; productInterest: string | null })
  | (CrmEventBase & { kind: "lead_contacted"; leadId: string; dealId: string; memberId: string | null })
  | (CrmEventBase & {
      kind: "handoff";
      state: "HANDOFF_OPENED" | "HANDOFF_ACCEPTED" | "HANDOFF_CLOSED";
      conversationId: string;
      handoffId: string;
    })
  | (CrmEventBase & {
      kind: "score";
      score: number;
      previousScore: number;
      temperature: CrmTemperature;
      previousTemperature: CrmTemperature;
      /** COLD / WARM → HOT in this change (ON_HOT assignment). */
      becameHot: boolean;
    })
  | (CrmEventBase & {
      kind: "stage_changed";
      dealId: string;
      fromStageId: string | null;
      toStageId: string;
      stageKind: CrmStageKind;
      actor: { kind: "SYSTEM" | "OPERATOR" | "AUTOMATION" | "AI"; memberId?: string | null };
    });

export type CrmListener = (event: CrmEvent) => void | Promise<void>;

const listeners = new Set<CrmListener>();

/** Subscribe; returns the unsubscribe function. */
export function registerCrmListener(fn: CrmListener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Tests / hot reload. */
export function clearCrmListeners(): void {
  listeners.clear();
}

/** Run every listener in order; a failing listener is logged and skipped. */
export async function emitCrmEvent(event: CrmEvent): Promise<void> {
  for (const fn of listeners) {
    try {
      await fn(event);
    } catch (error) {
      console.error(`[CRM] listener failed on ${event.kind}:`, error instanceof Error ? error.message : error);
    }
  }
}
