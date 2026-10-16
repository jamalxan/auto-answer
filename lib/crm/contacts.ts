/**
 * ETAP 5.0 — `CrmContact`: the single identity of a person per Instagram
 * business account, unique on (instagramAccountId, igUserId).
 *
 * The four production stores (InstagramContact, Conversation, Lead, DmLog)
 * keep writing exactly as before; this module folds whatever each of them
 * knows into the one row. Every write is a monotonic merge, so the hook, the
 * reconciler and the backfill can all run over the same facts in any order
 * and any number of times:
 *
 *   - a non-empty value never loses to an empty one (name, phone, ...);
 *   - firstInteractionAt only moves back, last* only forward;
 *   - interactionCount only grows (a replay with the same timestamp is a no-op).
 */

import type { CrmContact, CrmContactStatus, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { isUniqueViolation, recordActivity } from "./activity";
import { emitCrmEvent, type CrmInteractionVia } from "./hooks";
import type { WhereObject } from "./segments";
import { CONTACT_STATUS_LABELS, type CrmContactSource, type CrmTemperature } from "./types";

export const CONTACT_NOT_FOUND = "Kontakt topilmadi";

export interface UpsertContactInput {
  workspaceId: string;
  instagramAccountId: string;
  igUserId: string;
  username?: string | null;
  name?: string | null;
  phoneE164?: string | null;
  email?: string | null;
  language?: string | null;
  /** Only applied while the contact's source is still UNKNOWN. */
  source?: CrmContactSource | null;
  interactionAt?: Date | null;
  /** Backfill: the store's own first-seen time (only ever moves back). */
  firstInteractionAt?: Date | null;
  /** The person sent a DM / tapped a button: moves lastInboundAt, the 24h messaging-window anchor. */
  inbound?: boolean;
  /** We wrote to the person. */
  outbound?: boolean;
  /**
   * A comment or another interaction that counts but does not open the
   * messaging window (lastInteractionAt and the counter move, lastInboundAt
   * does not).
   */
  interaction?: boolean;
  conversationId?: string | null;
  instagramContactId?: string | null;
  /** A store's own counter (backfill): the larger value wins over the running count. */
  interactionCount?: number | null;
}

export interface UpsertContactOptions {
  /** Backfill: do not emit listener events for every row. */
  silent?: boolean;
  /** Which path produced the facts; passed to listeners. */
  via?: CrmInteractionVia;
  memberId?: string | null;
  payload?: Record<string, unknown> | null;
}

type Text = string | null | undefined;

function clean(value: Text, max = 200): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function later(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function earlier(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

const key = (input: Pick<UpsertContactInput, "instagramAccountId" | "igUserId">) => ({
  instagramAccountId_igUserId: { instagramAccountId: input.instagramAccountId, igUserId: input.igUserId },
});

const counts = (input: UpsertContactInput) => Boolean(input.inbound || input.outbound || input.interaction);

function createData(input: UpsertContactInput, links: boolean): Prisma.CrmContactUncheckedCreateInput {
  const at = input.interactionAt ?? null;
  const touched = Boolean(at && counts(input));
  return {
    workspaceId: input.workspaceId,
    instagramAccountId: input.instagramAccountId,
    igUserId: input.igUserId,
    username: clean(input.username),
    name: clean(input.name),
    phoneE164: clean(input.phoneE164, 32),
    email: clean(input.email),
    language: clean(input.language, 16),
    source: input.source ?? "UNKNOWN",
    firstInteractionAt: earlier(input.firstInteractionAt, at),
    lastInteractionAt: at,
    lastInboundAt: input.inbound ? at : null,
    lastOutboundAt: input.outbound ? at : null,
    interactionCount: Math.max(input.interactionCount ?? 0, touched ? 1 : 0),
    conversationId: links ? (input.conversationId ?? null) : null,
    instagramContactId: links ? (input.instagramContactId ?? null) : null,
  };
}

/** The monotonic diff; empty when nothing moves. */
function updateData(existing: CrmContact, input: UpsertContactInput): Prisma.CrmContactUncheckedUpdateInput {
  const data: Prisma.CrmContactUncheckedUpdateInput = {};
  const fill = (column: "username" | "name" | "phoneE164" | "email" | "language", value: Text, max?: number) => {
    const next = clean(value, max);
    if (next && !existing[column]) data[column] = next;
  };
  fill("username", input.username);
  fill("name", input.name);
  fill("phoneE164", input.phoneE164, 32);
  fill("email", input.email);
  fill("language", input.language, 16);
  if (input.source && input.source !== "UNKNOWN" && existing.source === "UNKNOWN") data.source = input.source;

  const at = input.interactionAt ?? null;
  const first = earlier(existing.firstInteractionAt, earlier(input.firstInteractionAt, at));
  if (first && first.getTime() !== existing.firstInteractionAt?.getTime()) data.firstInteractionAt = first;
  if (at) {
    const last = later(existing.lastInteractionAt, at);
    if (last && last.getTime() !== existing.lastInteractionAt?.getTime()) data.lastInteractionAt = last;
    if (input.inbound) {
      const inbound = later(existing.lastInboundAt, at);
      if (inbound && inbound.getTime() !== existing.lastInboundAt?.getTime()) data.lastInboundAt = inbound;
    }
    if (input.outbound) {
      const outbound = later(existing.lastOutboundAt, at);
      if (outbound && outbound.getTime() !== existing.lastOutboundAt?.getTime()) data.lastOutboundAt = outbound;
    }
  }

  if (typeof input.interactionCount === "number") {
    if (input.interactionCount > existing.interactionCount) data.interactionCount = input.interactionCount;
  } else if (at && counts(input)) {
    // A new interaction is one that is later than everything seen so far; a
    // replayed event (same timestamp) does not count twice.
    const newer = !existing.lastInteractionAt || at.getTime() > existing.lastInteractionAt.getTime();
    if (newer) data.interactionCount = { increment: 1 };
  }

  if (input.conversationId && !existing.conversationId) data.conversationId = input.conversationId;
  if (input.instagramContactId && !existing.instagramContactId) data.instagramContactId = input.instagramContactId;
  return data;
}

/** True when the update moves the timestamp this kind of interaction anchors (inbound / outbound / other). */
function movesAnchor(input: UpsertContactInput, data: Prisma.CrmContactUncheckedUpdateInput): boolean {
  if (input.inbound && data.lastInboundAt !== undefined) return true;
  if (input.outbound && data.lastOutboundAt !== undefined) return true;
  if (input.interaction && data.lastInteractionAt !== undefined) return true;
  return false;
}

/**
 * Find-or-create on (instagramAccountId, igUserId) and merge the given facts
 * in. Idempotent; two workers racing on a new person both end up with the
 * same row.
 */
export async function upsertContactFromParts(
  input: UpsertContactInput,
  options: UpsertContactOptions = {}
): Promise<CrmContact> {
  const where = key(input);
  let contact = await prisma.crmContact.findUnique({ where });
  // Did this call move the anchor of its own direction forward? A replay of
  // an interaction we already hold (the reconciler re-reading
  // lastCustomerMessageAt after a hook, a retried job) must not reach the
  // listeners again — e.g. re-applying an old "stop" after a manual opt-in.
  let advanced = false;
  if (!contact) {
    try {
      contact = await prisma.crmContact.create({ data: createData(input, true) });
      advanced = true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either the other worker won the race on the key, or the conversation /
      // trigger contact is already linked to another row: retry without links.
      contact = await prisma.crmContact.findUnique({ where });
      if (!contact) {
        contact = await prisma.crmContact.create({ data: createData(input, false) });
        contact = await applyUpdate(contact, { conversationId: input.conversationId ?? undefined, instagramContactId: input.instagramContactId ?? undefined });
        advanced = true;
      } else {
        const data = updateData(contact, input);
        advanced = movesAnchor(input, data);
        contact = await applyUpdate(contact, data);
      }
    }
  } else {
    const data = updateData(contact, input);
    advanced = movesAnchor(input, data);
    contact = await applyUpdate(contact, data);
  }

  if (!options.silent && advanced && input.interactionAt && counts(input)) {
    await emitCrmEvent({
      kind: "interaction",
      direction: input.outbound ? "outbound" : "inbound",
      via: options.via ?? "reconcile",
      workspaceId: contact.workspaceId,
      contactId: contact.id,
      contact,
      conversationId: contact.conversationId,
      memberId: options.memberId ?? null,
      at: input.interactionAt,
      payload: options.payload ?? null,
    });
  }
  return contact;
}

const defined = (data: Prisma.CrmContactUncheckedUpdateInput) =>
  Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Prisma.CrmContactUncheckedUpdateInput;

async function applyUpdate(contact: CrmContact, input: Prisma.CrmContactUncheckedUpdateInput): Promise<CrmContact> {
  const data = defined(input);
  if (Object.keys(data).length === 0) return contact;
  // A conversation / trigger contact may already be linked to another row:
  // retry without the link that clashes, then without both, never losing the rest.
  const { conversationId, instagramContactId, ...rest } = data;
  const attempts = [data, { ...rest, instagramContactId }, { ...rest, conversationId }, rest].map(defined);
  for (const attempt of attempts) {
    if (Object.keys(attempt).length === 0) return contact;
    try {
      return await prisma.crmContact.update({ where: { id: contact.id }, data: attempt });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return contact;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

const contactInclude = {
  tags: { include: { tag: true } },
  deals: { include: { stage: true }, orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.CrmContactInclude;

export type ContactWithRelations = Prisma.CrmContactGetPayload<{ include: typeof contactInclude }>;

export async function getContact(workspaceId: string, contactId: string): Promise<ContactWithRelations | null> {
  return prisma.crmContact.findFirst({ where: { id: contactId, workspaceId }, include: contactInclude });
}

export async function findContactByConversation(conversationId: string): Promise<CrmContact | null> {
  return prisma.crmContact.findUnique({ where: { conversationId } });
}

export async function findContactByInstagramContact(instagramContactId: string): Promise<CrmContact | null> {
  return prisma.crmContact.findUnique({ where: { instagramContactId } });
}

export async function findContactByIgUser(instagramAccountId: string, igUserId: string): Promise<CrmContact | null> {
  return prisma.crmContact.findUnique({ where: { instagramAccountId_igUserId: { instagramAccountId, igUserId } } });
}

export type ContactOrder = "lastInteractionAt" | "createdAt" | "updatedAt" | "score";

export interface ListContactsOptions {
  /** From compileSegmentWhere (no workspaceId; the list adds it). */
  where?: WhereObject | null;
  /** Free text over username / name / phone. */
  q?: string | null;
  /** The `nextCursor` of the previous page (a contact id). */
  cursor?: string | null;
  limit?: number;
  orderBy?: ContactOrder;
  /** Rows merged into another contact are hidden unless asked for. */
  includeMerged?: boolean;
}

export interface ContactPage {
  items: ContactWithRelations[];
  nextCursor: string | null;
  total: number;
}

export const CONTACT_PAGE_LIMIT = 50;

export function buildContactWhere(
  workspaceId: string,
  options: Pick<ListContactsOptions, "where" | "q" | "includeMerged"> = {}
): Prisma.CrmContactWhereInput {
  const clauses: Prisma.CrmContactWhereInput[] = [{ workspaceId }];
  if (!options.includeMerged) clauses.push({ mergedIntoId: null });
  if (options.where && Object.keys(options.where).length > 0) clauses.push(options.where as Prisma.CrmContactWhereInput);
  const q = options.q?.trim();
  if (q) {
    const needle = q.replace(/^@/, "");
    clauses.push({
      OR: [
        { username: { contains: needle, mode: "insensitive" } },
        { name: { contains: needle, mode: "insensitive" } },
        { phoneE164: { contains: needle.replace(/[\s()-]/g, "") } },
        { igUserId: needle },
      ],
    });
  }
  return { AND: clauses };
}

/**
 * Keyset-paged list, newest activity first by default. `total` is the count
 * of the whole filter (the segment preview shows it next to the rows).
 */
export async function listContacts(workspaceId: string, options: ListContactsOptions = {}): Promise<ContactPage> {
  const limit = Math.min(Math.max(options.limit ?? CONTACT_PAGE_LIMIT, 1), 200);
  const order = options.orderBy ?? "lastInteractionAt";
  const where = buildContactWhere(workspaceId, options);
  const orderBy: Prisma.CrmContactOrderByWithRelationInput[] = [
    order === "lastInteractionAt" ? { lastInteractionAt: { sort: "desc", nulls: "last" } } : { [order]: "desc" },
    { id: "desc" },
  ];
  const [rows, total] = await Promise.all([
    prisma.crmContact.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      include: contactInclude,
    }),
    prisma.crmContact.count({ where }),
  ]);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null, total };
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export type CrmActor = { kind: "SYSTEM" | "OPERATOR" | "AUTOMATION" | "AI"; memberId?: string | null };

export type CrmServiceResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export async function setContactStatus(
  workspaceId: string,
  contactId: string,
  status: CrmContactStatus,
  actor: CrmActor
): Promise<CrmServiceResult<CrmContact>> {
  const contact = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId } });
  if (!contact) return { ok: false, status: 404, error: CONTACT_NOT_FOUND };
  if (contact.status === status) return { ok: true, data: contact };
  const updated = await prisma.crmContact.update({ where: { id: contact.id }, data: { status } });
  await recordActivity({
    workspaceId,
    contactId: contact.id,
    type: "FIELD_CHANGED",
    occurredAt: new Date(),
    actorKind: actor.kind,
    actorMemberId: actor.memberId ?? null,
    title: `Holat: ${CONTACT_STATUS_LABELS[contact.status]} → ${CONTACT_STATUS_LABELS[status]}`,
    payload: { field: "status", from: contact.status, to: status },
  });
  return { ok: true, data: updated };
}

/**
 * Copy score / temperature from JavobAI's AiConversationState onto the
 * contact (hasAiState = true). Writes SCORE_CHANGED / TEMPERATURE_CHANGED
 * activities, idempotent per state version, and emits the "score" event
 * (becameHot for ON_HOT assignment). Null when the conversation has no
 * contact yet.
 */
export async function mirrorAiState(conversationId: string, options: { silent?: boolean } = {}): Promise<CrmContact | null> {
  const contact = await prisma.crmContact.findUnique({ where: { conversationId } });
  if (!contact) return null;
  const state = await prisma.aiConversationState.findUnique({ where: { conversationId } });
  if (!state) return contact;

  const scoreChanged = state.score !== contact.score;
  const temperatureChanged = state.temperature !== contact.temperature;
  if (!scoreChanged && !temperatureChanged && contact.hasAiState) return contact;

  const updated = await prisma.crmContact.update({
    where: { id: contact.id },
    data: { score: state.score, temperature: state.temperature, hasAiState: true },
  });
  const version = `${state.id}:${state.updatedAt.getTime()}`;
  if (scoreChanged) {
    await recordActivity({
      workspaceId: contact.workspaceId,
      contactId: contact.id,
      type: "SCORE_CHANGED",
      occurredAt: state.updatedAt,
      actorKind: "AI",
      title: `Ball: ${contact.score} → ${state.score}`,
      payload: { from: contact.score, to: state.score },
      sourceTable: "AiConversationState",
      sourceId: version,
    });
  }
  if (temperatureChanged) {
    await recordActivity({
      workspaceId: contact.workspaceId,
      contactId: contact.id,
      type: "TEMPERATURE_CHANGED",
      occurredAt: state.updatedAt,
      actorKind: "AI",
      title: `Harorat: ${contact.temperature} → ${state.temperature}`,
      payload: { from: contact.temperature, to: state.temperature },
      sourceTable: "AiConversationState",
      sourceId: version,
    });
  }
  if (options.silent) return updated;
  await emitCrmEvent({
    kind: "score",
    workspaceId: contact.workspaceId,
    contactId: contact.id,
    contact: updated,
    score: state.score,
    previousScore: contact.score,
    temperature: state.temperature as CrmTemperature,
    previousTemperature: contact.temperature as CrmTemperature,
    becameHot: state.temperature === "HOT" && contact.temperature !== "HOT",
  });
  return updated;
}
