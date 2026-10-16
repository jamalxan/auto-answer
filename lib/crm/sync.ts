/**
 * ETAP 5.0 — keeping CrmContact in step with the four production stores.
 *
 * Two paths feed the same monotonic upserts (lib/crm/contacts.ts), so order
 * and repetition do not matter:
 *
 *   applyCrmTouch   the "crm-touch" job behind lib/crm/hooks.ts crmTouch —
 *                   immediate, one job per engine event;
 *   runCrmReconcile the 5-minute safety net (design 4b): a keyset cursor per
 *                   source in CrmSyncCursor, batches of ≤ 500, idempotent.
 *
 * Reconciled sources: InstagramEvent (createdAt), Conversation (updatedAt),
 * Lead (createdAt → deal) plus a 30-day rescan for contactedAt / deliveries,
 * TriggerExecution (updatedAt, outbound), AiHandoff (openedAt, + 30-day
 * rescan for accept / close), AiConversationState (updatedAt → mirror),
 * DmLog (createdAt, legacy campaigns). Every scan is a keyset over a
 * `(column, id)` index.
 *
 * The reconciler never imports history: a source without a cursor starts at
 * "now" (history comes only from the explicit backfill), the rescans never
 * read before the cursor's creation, each scan stops RECONCILE_LAG_MS before
 * now (a transaction still in flight may commit an older timestamp), and
 * deal / handoff / score writes are silent — listeners (assignment, Telegram
 * alerts, broadcast attribution) fire from the hooks only. Interactions still
 * reach listeners, but only when they move the contact forward (contacts.ts).
 */

import type { AiHandoff, Conversation, InstagramEventType, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { NO_AUTOMATION_REASON } from "@/lib/triggers/normalize";
import { recordActivity } from "./activity";
import { mirrorAiState, upsertContactFromParts, type UpsertContactInput } from "./contacts";
import { emitCrmEvent } from "./hooks";
import { ensureDealForLead, markLeadContacted } from "./pipeline";
import type { CrmTouchInput } from "./queue";
import { ACTIVITY_TYPE_LABELS, type CrmContactSource } from "./types";

const DAY_MS = 24 * 3600_000;
export const RECONCILE_BATCH = 500;
/** Batches one run may take per source (a backlog drains over several runs). */
export const RECONCILE_MAX_BATCHES = 10;
export const RESCAN_WINDOW_MS = 30 * DAY_MS;
/** Rows newer than now − this are left for the next run (late commits with an older timestamp). */
export const RECONCILE_LAG_MS = 60_000;

export const RECONCILE_SOURCES = [
  "instagramEvent",
  "conversation",
  "lead",
  "leadRescan",
  "triggerExecution",
  "aiHandoff",
  "aiState",
  "dmLog",
] as const;
export type ReconcileSource = (typeof RECONCILE_SOURCES)[number];

const INTERACTION_EVENT_TYPES: InstagramEventType[] = ["COMMENT", "LIVE_COMMENT", "DIRECT_MESSAGE", "STORY_REPLY", "STORY_MENTION"];

// ─── Mapping helpers ──────────────────────────────────────────────────────────

export function sourceFromEventType(eventType: InstagramEventType, referralSource?: string | null, ref?: string | null): CrmContactSource {
  switch (eventType) {
    case "COMMENT":
    case "LIVE_COMMENT":
      return "COMMENT";
    case "STORY_REPLY":
    case "STORY_MENTION":
    case "STORY_REACTION":
      return "STORY";
    case "DIRECT_MESSAGE":
    case "MESSAGE_REACTION":
      if (referralSource === "ADS") return "AD";
      if (ref || referralSource) return "LINK";
      return "DM";
  }
  return "UNKNOWN";
}

/** Comments do not open the messaging window; DMs, story replies and mentions do. */
export function opensMessagingWindow(eventType: InstagramEventType): boolean {
  return eventType === "DIRECT_MESSAGE" || eventType === "STORY_REPLY" || eventType === "STORY_MENTION";
}

interface CollectedShape {
  name?: string | null;
  phone_e164?: string | null;
  language?: string | null;
}

function readCollected(value: unknown): CollectedShape {
  return value && typeof value === "object" ? (value as CollectedShape) : {};
}

/** The facts a production Conversation holds about the person. */
export function contactFromConversation(conversation: Conversation): UpsertContactInput {
  const collected = readCollected(conversation.collected);
  return {
    workspaceId: conversation.workspaceId,
    instagramAccountId: conversation.instagramAccountId,
    igUserId: conversation.igUserId,
    username: conversation.igUsername,
    name: collected.name ?? conversation.igName,
    phoneE164: collected.phone_e164,
    language: collected.language,
    source: conversation.source === "CAMPAIGN" ? "COMMENT" : "DM",
    conversationId: conversation.id,
    firstInteractionAt: conversation.createdAt,
  };
}

async function memberIdFor(workspaceId: string, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true },
  });
  return member?.id ?? null;
}

// ─── Handoffs ─────────────────────────────────────────────────────────────────

type HandoffState = "HANDOFF_OPENED" | "HANDOFF_ACCEPTED" | "HANDOFF_CLOSED";

/**
 * HANDOFF_OPENED / ACCEPTED / CLOSED activities for the given AiHandoff rows,
 * one each (idempotent on "AiHandoff:<id>:<phase>"), with the "handoff"
 * event for every row written. Returns how many were new.
 */
export async function syncHandoffRows(handoffs: AiHandoff[], options: { silent?: boolean } = {}): Promise<number> {
  if (handoffs.length === 0) return 0;
  const conversationIds = Array.from(new Set(handoffs.map((h) => h.conversationId)));
  const contacts = await prisma.crmContact.findMany({ where: { conversationId: { in: conversationIds } } });
  const byConversation = new Map(contacts.map((c) => [c.conversationId!, c]));

  const wanted: Array<{ handoff: AiHandoff; phase: HandoffState; at: Date; sourceId: string }> = [];
  for (const h of handoffs) {
    wanted.push({ handoff: h, phase: "HANDOFF_OPENED", at: h.openedAt, sourceId: `${h.id}:opened` });
    if (h.acceptedAt) wanted.push({ handoff: h, phase: "HANDOFF_ACCEPTED", at: h.acceptedAt, sourceId: `${h.id}:accepted` });
    if (h.closedAt) wanted.push({ handoff: h, phase: "HANDOFF_CLOSED", at: h.closedAt, sourceId: `${h.id}:closed` });
  }
  const existing = await prisma.crmActivity.findMany({
    where: { sourceTable: "AiHandoff", sourceId: { in: wanted.map((w) => w.sourceId) } },
    select: { sourceId: true, type: true },
  });
  const seen = new Set(existing.map((e) => `${e.sourceId}|${e.type}`));

  let created = 0;
  for (const w of wanted) {
    if (seen.has(`${w.sourceId}|${w.phase}`)) continue;
    const contact = byConversation.get(w.handoff.conversationId);
    if (!contact) continue; // the conversation pass creates the contact first
    const h = w.handoff;
    const actorKind = w.phase === "HANDOFF_OPENED" ? "AI" : w.phase === "HANDOFF_CLOSED" && (h.closedBy === "inactivity" || h.closedBy === "reopen") ? "SYSTEM" : "OPERATOR";
    const row = await recordActivity({
      workspaceId: contact.workspaceId,
      contactId: contact.id,
      type: w.phase,
      occurredAt: w.at,
      actorKind,
      title: ACTIVITY_TYPE_LABELS[w.phase],
      body: w.phase === "HANDOFF_OPENED" ? h.reason : w.phase === "HANDOFF_ACCEPTED" ? h.acceptedBy : h.closedBy,
      payload: { handoffId: h.id, reason: h.reason, acceptedBy: h.acceptedBy, closedBy: h.closedBy, resumeAi: h.resumeAi },
      sourceTable: "AiHandoff",
      sourceId: w.sourceId,
    });
    if (!row) continue;
    created++;
    if (options.silent) continue;
    await emitCrmEvent({ kind: "handoff", state: w.phase, workspaceId: contact.workspaceId, contactId: contact.id, contact, conversationId: h.conversationId, handoffId: h.id });
  }
  return created;
}

async function syncHandoffsOfConversation(conversationId: string): Promise<number> {
  const rows = await prisma.aiHandoff.findMany({ where: { conversationId }, orderBy: { openedAt: "asc" } });
  return syncHandoffRows(rows);
}

// ─── Lead rescan (contacted + deliveries) ─────────────────────────────────────

type LeadWithDeliveries = Prisma.LeadGetPayload<{ include: { deliveries: { include: { integration: { select: { type: true; name: true } } } } } }>;

const INTEGRATION_LABELS: Record<string, string> = {
  TELEGRAM: "Telegram",
  AMOCRM: "amoCRM",
  BITRIX24: "Bitrix24",
  GOOGLE_SHEETS: "Google Sheets",
  WEBHOOK: "Webhook",
};

/** Lead.contactedAt → "Bog'lanildi"; SENT deliveries → LEAD_DELIVERED. Idempotent. */
export async function syncLeadRows(leads: LeadWithDeliveries[], options: { silent?: boolean } = {}): Promise<number> {
  if (leads.length === 0) return 0;
  const deals = await prisma.crmDeal.findMany({
    where: { leadId: { in: leads.map((l) => l.id) } },
    include: { stage: { select: { isEntry: true } } },
  });
  const dealByLead = new Map(deals.map((d) => [d.leadId!, d]));
  const deliveryIds = leads.flatMap((l) => l.deliveries.filter((d) => d.status === "SENT" && d.sentAt).map((d) => d.id));
  const delivered = new Set(
    deliveryIds.length
      ? (
          await prisma.crmActivity.findMany({
            where: { sourceTable: "LeadDelivery", type: "LEAD_DELIVERED", sourceId: { in: deliveryIds } },
            select: { sourceId: true },
          })
        ).map((a) => a.sourceId)
      : []
  );

  let changed = 0;
  for (const lead of leads) {
    if (lead.isTest) continue;
    let deal = dealByLead.get(lead.id) ?? null;
    if (!deal) {
      const made = await ensureDealForLead(lead.id, { silent: options.silent });
      if (made) {
        changed++;
        deal = { ...made, stage: { isEntry: true } };
      }
    }
    if (!deal) continue;
    if (lead.contactedAt && deal.stage.isEntry) {
      await markLeadContacted(lead.id, { silent: options.silent });
      changed++;
    }
    for (const d of lead.deliveries) {
      if (d.status !== "SENT" || !d.sentAt || delivered.has(d.id)) continue;
      const label = INTEGRATION_LABELS[d.integration.type] ?? d.integration.name;
      const row = await recordActivity({
        workspaceId: lead.workspaceId,
        contactId: deal.contactId,
        dealId: deal.id,
        type: "LEAD_DELIVERED",
        occurredAt: d.sentAt,
        actorKind: "SYSTEM",
        title: `${ACTIVITY_TYPE_LABELS.LEAD_DELIVERED}: ${label}`,
        payload: { leadId: lead.id, integrationType: d.integration.type, kind: d.kind, externalUrl: d.externalUrl },
        sourceTable: "LeadDelivery",
        sourceId: d.id,
      });
      if (row) changed++;
    }
  }
  return changed;
}

// ─── Touch (the hook's job) ───────────────────────────────────────────────────

async function resolveConversation(input: CrmTouchInput): Promise<Conversation | null> {
  if (input.conversationId) return prisma.conversation.findUnique({ where: { id: input.conversationId } });
  if (input.aiStateId) {
    const state = await prisma.aiConversationState.findUnique({ where: { id: input.aiStateId }, select: { conversationId: true } });
    if (state) return prisma.conversation.findUnique({ where: { id: state.conversationId } });
  }
  if (input.instagramAccountId && input.igUserId) {
    return prisma.conversation.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId: input.instagramAccountId, igUserId: input.igUserId } },
    });
  }
  return null;
}

/** The facts the hook carried when there is no conversation to read them from. */
function bareContact(input: CrmTouchInput): UpsertContactInput | null {
  if (!input.workspaceId || !input.instagramAccountId || !input.igUserId) return null;
  return { workspaceId: input.workspaceId, instagramAccountId: input.instagramAccountId, igUserId: input.igUserId };
}

/**
 * Apply one hook event. Every branch is idempotent, so BullMQ's retries are
 * safe. Unknown ids are ignored (the row may have been deleted meanwhile).
 */
export async function applyCrmTouch(input: CrmTouchInput): Promise<void> {
  const at = input.at ? new Date(input.at) : new Date();
  const payload = input.payload ?? null;

  switch (input.kind) {
    case "inbound":
    case "operator_reply":
    case "ai_reply":
    case "automation_reply": {
      const conversation = await resolveConversation(input);
      const base = conversation ? contactFromConversation(conversation) : bareContact(input);
      if (!base) return;
      const outbound = input.kind !== "inbound";
      const memberId = input.kind === "operator_reply" && conversation ? await memberIdFor(conversation.workspaceId, input.userId) : null;
      await upsertContactFromParts(
        { ...base, interactionAt: at, inbound: !outbound, outbound },
        { via: input.kind, memberId, payload }
      );
      if (input.kind === "ai_reply" && conversation) await mirrorAiState(conversation.id);
      return;
    }
    case "trigger_interaction": {
      if (!input.instagramContactId) return;
      const contact = await prisma.instagramContact.findUnique({ where: { id: input.instagramContactId } });
      if (!contact) return;
      const eventType = (payload?.eventType as InstagramEventType | undefined) ?? contact.source;
      const inbound = opensMessagingWindow(eventType);
      await upsertContactFromParts(
        {
          workspaceId: contact.workspaceId,
          instagramAccountId: contact.instagramAccountId,
          igUserId: contact.igUserId,
          username: contact.username,
          name: contact.name,
          phoneE164: contact.phone,
          email: contact.email,
          source: sourceFromEventType(contact.source),
          instagramContactId: contact.id,
          firstInteractionAt: contact.firstInteractionAt,
          interactionAt: at,
          inbound,
          interaction: !inbound,
        },
        { via: "trigger_interaction", payload }
      );
      return;
    }
    case "lead_created": {
      if (input.leadId) await ensureDealForLead(input.leadId);
      return;
    }
    case "lead_contacted": {
      if (input.leadId) await markLeadContacted(input.leadId, { userId: input.userId });
      return;
    }
    case "handoff": {
      const conversation = await resolveConversation(input);
      if (!conversation) return;
      await upsertContactFromParts(contactFromConversation(conversation), { silent: true });
      await syncHandoffsOfConversation(conversation.id);
      return;
    }
    case "score": {
      const conversation = await resolveConversation(input);
      if (!conversation) return;
      await upsertContactFromParts(contactFromConversation(conversation), { silent: true });
      await mirrorAiState(conversation.id);
      return;
    }
  }
}

// ─── Reconciler ───────────────────────────────────────────────────────────────

interface Cursor {
  at: Date;
  id: string | null;
}

interface CursorState {
  cursor: Cursor;
  /** When the cursor was seeded: the 30-day rescans never read before it. */
  floor: Date;
}

async function readCursor(source: ReconcileSource): Promise<CursorState | null> {
  const row = await prisma.crmSyncCursor.findUnique({ where: { source } });
  return row ? { cursor: { at: row.cursorAt, id: row.cursorId }, floor: row.createdAt } : null;
}

/** First run of a source: start at `at` (history is the backfill's job). A racing seed keeps the winner. */
async function seedCursor(source: ReconcileSource, at: Date): Promise<CursorState> {
  await prisma.crmSyncCursor.upsert({
    where: { source },
    create: { source, cursorAt: at, cursorId: null, createdAt: at },
    update: {},
  });
  return (await readCursor(source)) ?? { cursor: { at, id: null }, floor: at };
}

async function writeCursor(source: ReconcileSource, cursor: Cursor): Promise<void> {
  await prisma.crmSyncCursor.upsert({
    where: { source },
    create: { source, cursorAt: cursor.at, cursorId: cursor.id },
    update: { cursorAt: cursor.at, cursorId: cursor.id },
  });
}

/** `(column, id) > (cursor.at, cursor.id) AND column <= bound` as one AND clause (composable with other filters). */
function after(column: string, cursor: Cursor, bound: Date): Record<string, unknown> {
  const upper = { [column]: { lte: bound } };
  if (!cursor.id) return { AND: [{ [column]: { gt: cursor.at } }, upper] };
  return { AND: [{ OR: [{ [column]: { gt: cursor.at } }, { [column]: cursor.at, id: { gt: cursor.id } }] }, upper] };
}

const ascending = (column: string) => [{ [column]: "asc" as const }, { id: "asc" as const }];

interface BatchResult {
  processed: number;
  /** Cursor after the batch; null when the batch was empty. */
  last: Cursor | null;
}

interface BatchContext {
  now: Date;
  /** Upper bound of every scan: now − RECONCILE_LAG_MS. */
  bound: Date;
  /** The source's seed time (rescans start at max(now − 30 days, floor)). */
  floor: Date;
}

type BatchFn = (cursor: Cursor, ctx: BatchContext) => Promise<BatchResult>;

/** Where a 30-day rescan starts: its own cursor while inside the window, else the window edge (never before the seed). */
function rescanFrom(cursor: Cursor, ctx: BatchContext): { from: Cursor; edge: Cursor } {
  const windowStart = ctx.now.getTime() - RESCAN_WINDOW_MS;
  const edge: Cursor = { at: new Date(Math.max(windowStart, ctx.floor.getTime())), id: null };
  return { from: cursor.at.getTime() >= edge.at.getTime() ? cursor : edge, edge };
}

async function instagramEventBatch(cursor: Cursor, ctx: BatchContext): Promise<BatchResult> {
  const rows = await prisma.instagramEvent.findMany({
    where: {
      AND: [
        after("createdAt", cursor, ctx.bound),
        { eventType: { in: INTERACTION_EVENT_TYPES } },
        // B-28: log-only rows (no automation on the account) never create CRM contacts.
        { OR: [{ error: null }, { error: { not: NO_AUTOMATION_REASON } }] },
      ],
    },
    orderBy: ascending("createdAt"),
    take: RECONCILE_BATCH,
  });
  for (const e of rows) {
    const inbound = opensMessagingWindow(e.eventType);
    await upsertContactFromParts(
      {
        workspaceId: e.workspaceId,
        instagramAccountId: e.instagramAccountId,
        igUserId: e.senderId,
        username: e.senderUsername,
        source: sourceFromEventType(e.eventType, e.referralSource, e.ref),
        instagramContactId: e.contactId,
        interactionAt: e.timestamp,
        inbound,
        interaction: !inbound,
      },
      { via: "reconcile", payload: { eventType: e.eventType, eventId: e.id } }
    );
  }
  const last = rows[rows.length - 1];
  return { processed: rows.length, last: last ? { at: last.createdAt, id: last.id } : null };
}

async function conversationBatch(cursor: Cursor, ctx: BatchContext): Promise<BatchResult> {
  const rows = await prisma.conversation.findMany({
    where: after("updatedAt", cursor, ctx.bound),
    orderBy: ascending("updatedAt"),
    take: RECONCILE_BATCH,
  });
  for (const c of rows) {
    const base = contactFromConversation(c);
    if (c.lastCustomerMessageAt) {
      await upsertContactFromParts({ ...base, interactionAt: c.lastCustomerMessageAt, inbound: true }, { via: "reconcile" });
    } else {
      await upsertContactFromParts(base, { silent: true });
    }
    if (c.lastBotMessageAt) {
      await upsertContactFromParts({ ...base, interactionAt: c.lastBotMessageAt, outbound: true }, { silent: true });
    }
  }
  const last = rows[rows.length - 1];
  return { processed: rows.length, last: last ? { at: last.updatedAt, id: last.id } : null };
}

async function leadBatch(cursor: Cursor, ctx: BatchContext): Promise<BatchResult> {
  const rows = await prisma.lead.findMany({
    where: { AND: [after("createdAt", cursor, ctx.bound), { isTest: false }] },
    orderBy: ascending("createdAt"),
    take: RECONCILE_BATCH,
    select: { id: true, createdAt: true },
  });
  for (const lead of rows) await ensureDealForLead(lead.id, { silent: true });
  const last = rows[rows.length - 1];
  return { processed: rows.length, last: last ? { at: last.createdAt, id: last.id } : null };
}

/** 30-day rescan: contactedAt and SENT deliveries land after the lead's createdAt cursor passed. */
async function leadRescanBatch(cursor: Cursor, ctx: BatchContext): Promise<BatchResult> {
  const { from, edge } = rescanFrom(cursor, ctx);
  const rows = await prisma.lead.findMany({
    where: {
      AND: [
        after("createdAt", from, ctx.bound),
        { isTest: false },
        { OR: [{ contactedAt: { not: null } }, { deliveries: { some: { status: "SENT" } } }] },
      ],
    },
    orderBy: ascending("createdAt"),
    take: RECONCILE_BATCH,
    include: { deliveries: { include: { integration: { select: { type: true, name: true } } } } },
  });
  await syncLeadRows(rows, { silent: true });
  const last = rows[rows.length - 1];
  // End of the window: start over from the edge next time (the window slides).
  return { processed: rows.length, last: last ? { at: last.createdAt, id: last.id } : edge };
}

async function triggerExecutionBatch(cursor: Cursor, ctx: BatchContext): Promise<BatchResult> {
  const rows = await prisma.triggerExecution.findMany({
    where: { AND: [after("updatedAt", cursor, ctx.bound), { status: "SENT", sentAt: { not: null } }] },
    orderBy: ascending("updatedAt"),
    take: RECONCILE_BATCH,
    include: { event: { select: { workspaceId: true, instagramAccountId: true, senderId: true, senderUsername: true, contactId: true, eventType: true } } },
  });
  for (const e of rows) {
    await upsertContactFromParts(
      {
        workspaceId: e.event.workspaceId,
        instagramAccountId: e.event.instagramAccountId,
        igUserId: e.event.senderId,
        username: e.event.senderUsername,
        source: sourceFromEventType(e.event.eventType),
        instagramContactId: e.event.contactId,
        interactionAt: e.sentAt!,
        outbound: true,
      },
      { via: "reconcile", payload: { executionId: e.id, campaignId: e.campaignId, eventType: e.event.eventType } }
    );
  }
  const last = rows[rows.length - 1];
  return { processed: rows.length, last: last ? { at: last.updatedAt, id: last.id } : null };
}

async function aiHandoffBatch(cursor: Cursor, ctx: BatchContext): Promise<BatchResult> {
  // Opens by cursor; accept / close have no timestamp index, so the window rescans them.
  const { from, edge } = rescanFrom(cursor, ctx);
  const rows = await prisma.aiHandoff.findMany({
    where: after("openedAt", from, ctx.bound),
    orderBy: ascending("openedAt"),
    take: RECONCILE_BATCH,
  });
  await syncHandoffRows(rows, { silent: true });
  const last = rows[rows.length - 1];
  return { processed: rows.length, last: last ? { at: last.openedAt, id: last.id } : edge };
}

async function aiStateBatch(cursor: Cursor, ctx: BatchContext): Promise<BatchResult> {
  const rows = await prisma.aiConversationState.findMany({
    where: after("updatedAt", cursor, ctx.bound),
    orderBy: ascending("updatedAt"),
    take: RECONCILE_BATCH,
    select: { id: true, conversationId: true, updatedAt: true },
  });
  for (const s of rows) {
    if (!(await mirrorAiState(s.conversationId, { silent: true }))) {
      // No contact yet (conversation pass not run): make one, then mirror.
      const conversation = await prisma.conversation.findUnique({ where: { id: s.conversationId } });
      if (!conversation) continue;
      await upsertContactFromParts(contactFromConversation(conversation), { silent: true });
      await mirrorAiState(s.conversationId, { silent: true });
    }
  }
  const last = rows[rows.length - 1];
  return { processed: rows.length, last: last ? { at: last.updatedAt, id: last.id } : null };
}

async function dmLogBatch(cursor: Cursor, ctx: BatchContext): Promise<BatchResult> {
  const rows = await prisma.dmLog.findMany({
    where: after("createdAt", cursor, ctx.bound),
    orderBy: ascending("createdAt"),
    take: RECONCILE_BATCH,
  });
  for (const log of rows) {
    const base: UpsertContactInput = {
      workspaceId: log.workspaceId,
      instagramAccountId: log.instagramAccountId,
      igUserId: log.commenterId,
      name: log.commenterName,
      source: "COMMENT",
    };
    await upsertContactFromParts({ ...base, interactionAt: log.createdAt, interaction: true }, { silent: true });
    if (log.status === "SENT" && log.dmSentAt) {
      await upsertContactFromParts({ ...base, interactionAt: log.dmSentAt, outbound: true }, { silent: true });
    }
  }
  const last = rows[rows.length - 1];
  return { processed: rows.length, last: last ? { at: last.createdAt, id: last.id } : null };
}

const BATCHES: Record<ReconcileSource, BatchFn> = {
  instagramEvent: instagramEventBatch,
  conversation: conversationBatch,
  lead: leadBatch,
  leadRescan: leadRescanBatch,
  triggerExecution: triggerExecutionBatch,
  aiHandoff: aiHandoffBatch,
  aiState: aiStateBatch,
  dmLog: dmLogBatch,
};

export interface ReconcileOptions {
  sources?: ReconcileSource[];
  now?: Date;
  /** Batches per source in this run (default RECONCILE_MAX_BATCHES). */
  maxBatches?: number;
}

export type ReconcileCounts = Record<ReconcileSource, number>;

/**
 * Run every source's cursor forward. Rows processed per source; a failing
 * source is logged and skipped. A source seen for the first time is seeded at
 * now − RECONCILE_LAG_MS and reads nothing older (history = runBackfill).
 */
export async function runCrmReconcile(options: ReconcileOptions = {}): Promise<ReconcileCounts> {
  const now = options.now ?? new Date();
  const maxBatches = Math.max(1, options.maxBatches ?? RECONCILE_MAX_BATCHES);
  const bound = new Date(now.getTime() - RECONCILE_LAG_MS);
  const counts = Object.fromEntries(RECONCILE_SOURCES.map((s) => [s, 0])) as ReconcileCounts;
  for (const source of options.sources ?? RECONCILE_SOURCES) {
    try {
      const state = (await readCursor(source)) ?? (await seedCursor(source, bound));
      let cursor = state.cursor;
      const ctx: BatchContext = { now, bound, floor: state.floor };
      for (let i = 0; i < maxBatches; i++) {
        const batch = await BATCHES[source](cursor, ctx);
        counts[source] += batch.processed;
        if (batch.last) {
          cursor = batch.last;
          await writeCursor(source, cursor);
        }
        if (batch.processed < RECONCILE_BATCH) break;
      }
    } catch (error) {
      console.error(`[CRM] reconcile ${source} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return counts;
}
