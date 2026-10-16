/**
 * ETAP 5.4 — broadcast engine (TZ 33), policy-aware.
 *
 * Lifecycle: DRAFT → SCHEDULED (start job with delay) → RUNNING → COMPLETED,
 * with PAUSED / CANCELLED / FAILED on the side. At start the audience is
 * materialised: every matching CrmContact gets a CrmBroadcastRecipient with
 * its eligibility snapshot (lib/crm/broadcast-policy evaluateRecipient);
 * anyone not eligible is SKIPPED at once with the reason, never silently
 * dropped (Meta's 24-hour window, opt-out, frequency cap, active handoff —
 * owner decision 2).
 *
 * Delivery runs in batches on the "crm-broadcast" queue: one tick leases up
 * to batchSize(throttlePerHour) PENDING recipients (PENDING → SENDING per row,
 * so two workers never send the same DM), re-checks eligibility at send time,
 * and sends through sendGuarded (workspace quota + 750/h account bucket). A
 * rate-limit result puts the recipient back to PENDING and waits past the
 * hour; a quota denial is a FAILED with its reason. A SENDING row older than
 * ten minutes (worker died mid-send) becomes FAILED and is never resent — a
 * second DM is worse than none. Pause / cancel are re-read before every send.
 *
 * Every send that has a Conversation is stored as a SYSTEM ConversationMessage
 * with { llmMeta: { broadcastId } }, so lib/assistant/engine handleEcho sees a
 * known mid and never mistakes our own broadcast for an operator takeover.
 *
 * Attribution: a reply inside replyWindowHours after the send marks the
 * recipient (repliedAt), a deal created or advanced inside
 * conversionWindowDays marks a conversion; "stop" words opt the contact out.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { CrmBroadcast, CrmBroadcastRecipient, CrmBroadcastStatus, CrmRecipientStatus, Prisma } from "@/app/generated/prisma/client";
import {
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_TITLE,
  sendDirectMessage,
  sendDirectMessageWithQuickReplies,
  type QuickReplyOption,
} from "@/lib/meta/client";
import { readAccessToken, sendGuarded } from "@/lib/triggers/delivery";
import { TRIGGER_RATE_LIMIT_BACKOFF_MS } from "@/lib/triggers/queue";
import {
  batchSize,
  evaluateRecipient,
  isOptOutMessage,
  summarizeEligibility,
  windowClosesAt,
  type RecipientEvaluation,
} from "./broadcast-policy";
import {
  BROADCAST_BATCH_INTERVAL_MS,
  enqueueBroadcastBatch,
  enqueueBroadcastStart,
  isCrmEnabled,
  removeBroadcastJobs,
} from "./broadcast-queue";
import { emitBroadcastCompleted } from "@/lib/integrations2/emit";
import { DEFAULT_BROADCAST } from "./defaults";
import { registerCrmListener, type CrmEvent } from "./hooks";
import { done, fail, isUniqueViolation, type ServiceResult } from "./result";
import { compileSegmentWhere, EMPTY_FILTER, parseSegmentFilter, segmentFilterSchema, type SegmentFilter } from "./segments";
import {
  BROADCAST_STATUS_LABELS,
  INELIGIBILITY_LABELS,
  INELIGIBILITY_REASONS,
  RECIPIENT_STATUS_LABELS,
  type IneligibilityReason,
} from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

export const BROADCAST_MESSAGE_MAX = 1000;
export const BROADCAST_NAME_MAX = 120;
/** A SENDING row older than this lost its worker; it fails and is never resent. */
export const SENDING_LEASE_MS = 10 * 60_000;
/** Retryable (network) failures per recipient before it is FAILED. */
export const MAX_SEND_ATTEMPTS = 3;
/** Largest audience one broadcast materialises. */
export const AUDIENCE_MAX = 10_000;
/** Preview evaluates at most this many contacts (the count stays exact). */
export const PREVIEW_EVALUATE_MAX = 5_000;
export const PREVIEW_SAMPLE = 20;
const CHUNK = 500;

export const STALE_SENDING_ERROR = "Jarayon uzildi — ikki marta yubormaslik uchun qayta yuborilmadi.";
export const CANCELLED_ERROR = "Broadcast bekor qilindi.";
export const RATE_LIMIT_NOTE = "Soatlik DM limiti to'lgan — keyingi partiya bir soatdan keyin.";

export const BROADCAST_NOT_FOUND = "Broadcast topilmadi";
export const SEGMENT_NOT_FOUND = "Segment topilmadi";
export const ACCOUNT_NOT_FOUND = "Instagram akkaunt topilmadi — u boshqa workspace'ga tegishli yoki uzilgan";

export { BROADCAST_STATUS_LABELS, RECIPIENT_STATUS_LABELS };

// ─── Input ────────────────────────────────────────────────────────────────────

export const quickReplySchema = z.string().trim().min(1, "Tugma matni bo'sh").max(MAX_QUICK_REPLY_TITLE, `Tugma matni ko'pi bilan ${MAX_QUICK_REPLY_TITLE} belgi`);

export const broadcastInputSchema = z.object({
  name: z.string().trim().min(1, "Nom kiritilmagan").max(BROADCAST_NAME_MAX),
  instagramAccountId: z.string().min(1, "Akkaunt tanlanmagan"),
  segmentId: z.string().min(1).nullable().optional(),
  audienceFilter: segmentFilterSchema.nullable().optional(),
  message: z.string().trim().min(1, "Xabar matni bo'sh").max(BROADCAST_MESSAGE_MAX, `Xabar ko'pi bilan ${BROADCAST_MESSAGE_MAX} belgi`),
  quickReplies: z.array(quickReplySchema).max(MAX_QUICK_REPLIES, `Ko'pi bilan ${MAX_QUICK_REPLIES} ta tugma`).optional(),
  scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(),
  throttlePerHour: z.number().int().min(1).max(500).optional(),
  frequencyCapHours: z.number().int().min(0).max(24 * 30).optional(),
  replyWindowHours: z.number().int().min(1).max(24 * 14).optional(),
  conversionWindowDays: z.number().int().min(1).max(90).optional(),
});
export type BroadcastInput = z.infer<typeof broadcastInputSchema>;

export const broadcastUpdateSchema = broadcastInputSchema.partial();
export type BroadcastUpdate = z.infer<typeof broadcastUpdateSchema>;

export const scheduleInputSchema = z.object({ scheduledAt: z.iso.datetime({ offset: true }).nullable().optional() });

export const previewInputSchema = z.object({
  instagramAccountId: z.string().min(1, "Akkaunt tanlanmagan"),
  segmentId: z.string().min(1).nullable().optional(),
  audienceFilter: segmentFilterSchema.nullable().optional(),
  frequencyCapHours: z.number().int().min(0).max(24 * 30).optional(),
});
export type PreviewInput = z.infer<typeof previewInputSchema>;

export const recipientsQuerySchema = z.object({
  status: z.enum(["PENDING", "SENDING", "SENT", "SKIPPED", "FAILED"]).optional(),
  reason: z.enum(INELIGIBILITY_REASONS as [IneligibilityReason, ...IneligibilityReason[]]).optional(),
  replied: z.boolean().optional(),
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type RecipientsQuery = z.infer<typeof recipientsQuerySchema>;

// ─── Views ────────────────────────────────────────────────────────────────────

export interface BroadcastCounters {
  total: number;
  eligible: number;
  sent: number;
  skipped: number;
  failed: number;
  replied: number;
  converted: number;
  /** Still to send (RUNNING / PAUSED). */
  pending: number;
}

export interface BroadcastView {
  id: string;
  name: string;
  instagramAccountId: string;
  accountUsername: string | null;
  segmentId: string | null;
  segmentName: string | null;
  audienceFilter: SegmentFilter;
  message: string;
  quickReplies: string[];
  status: CrmBroadcastStatus;
  statusLabel: string;
  scheduledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  throttlePerHour: number;
  frequencyCapHours: number;
  replyWindowHours: number;
  conversionWindowDays: number;
  counters: BroadcastCounters;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecipientView {
  id: string;
  contactId: string;
  username: string | null;
  name: string | null;
  status: CrmRecipientStatus;
  statusLabel: string;
  eligible: boolean;
  reason: IneligibilityReason | null;
  reasonLabel: string | null;
  attempts: number;
  sentAt: Date | null;
  error: string | null;
  repliedAt: Date | null;
  convertedAt: Date | null;
  conversionDealId: string | null;
}

export interface RecipientsPage {
  recipients: RecipientView[];
  nextCursor: number | null;
  byStatus: Record<CrmRecipientStatus, number>;
  byReason: { reason: IneligibilityReason; label: string; count: number }[];
}

export interface AudiencePreview {
  total: number;
  eligibleNow: number;
  /** Contacts evaluated (= total unless the audience is larger than PREVIEW_EVALUATE_MAX). */
  evaluated: number;
  byReason: { reason: IneligibilityReason; label: string; count: number }[];
  sample: {
    contactId: string;
    username: string | null;
    name: string | null;
    eligible: boolean;
    reason: IneligibilityReason | null;
    label: string | null;
    windowClosesAt: Date | null;
  }[];
}

function quickRepliesOf(row: Pick<CrmBroadcast, "quickReplies">): string[] {
  const raw = row.quickReplies;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, MAX_QUICK_REPLIES);
}

function filterOf(row: Pick<CrmBroadcast, "audienceFilter">): SegmentFilter {
  return parseSegmentFilter(row.audienceFilter) ?? EMPTY_FILTER;
}

function toView(
  row: CrmBroadcast,
  extra: { accountUsername: string | null; segmentName: string | null; pending: number }
): BroadcastView {
  return {
    id: row.id,
    name: row.name,
    instagramAccountId: row.instagramAccountId,
    accountUsername: extra.accountUsername,
    segmentId: row.segmentId,
    segmentName: extra.segmentName,
    audienceFilter: filterOf(row),
    message: row.message,
    quickReplies: quickRepliesOf(row),
    status: row.status,
    statusLabel: BROADCAST_STATUS_LABELS[row.status],
    scheduledAt: row.scheduledAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    throttlePerHour: row.throttlePerHour,
    frequencyCapHours: row.frequencyCapHours,
    replyWindowHours: row.replyWindowHours,
    conversionWindowDays: row.conversionWindowDays,
    counters: {
      total: row.totalCount,
      eligible: row.eligibleCount,
      sent: row.sentCount,
      skipped: row.skippedCount,
      failed: row.failedCount,
      replied: row.repliedCount,
      converted: row.convertedCount,
      pending: extra.pending,
    },
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function reasonOf(value: string | null): IneligibilityReason | null {
  return value && (INELIGIBILITY_REASONS as string[]).includes(value) ? (value as IneligibilityReason) : null;
}

// ─── Lookups ──────────────────────────────────────────────────────────────────

type ContactLite = {
  id: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  conversationId: string | null;
  lastInboundAt: Date | null;
  optedOutAt: Date | null;
};

const CONTACT_SELECT = {
  id: true,
  igUserId: true,
  username: true,
  name: true,
  conversationId: true,
  lastInboundAt: true,
  optedOutAt: true,
} as const;

async function broadcastOf(workspaceId: string, id: string): Promise<CrmBroadcast | null> {
  return prisma.crmBroadcast.findFirst({ where: { id, workspaceId } });
}

async function accountOf(workspaceId: string, instagramAccountId: string) {
  return prisma.instagramAccount.findFirst({ where: { id: instagramAccountId, workspaceId } });
}

async function segmentOf(workspaceId: string, segmentId: string) {
  return prisma.crmSegment.findFirst({ where: { id: segmentId, workspaceId } });
}

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Facts the policy needs per contact that are not on the contact row itself. */
interface ContactFacts {
  handoffState: string | null;
  lastBroadcastSentAt: Date | null;
}

async function loadFacts(contacts: ContactLite[], excludeBroadcastId: string | null): Promise<Map<string, ContactFacts>> {
  const facts = new Map<string, ContactFacts>();
  for (const contact of contacts) facts.set(contact.id, { handoffState: null, lastBroadcastSentAt: null });

  const conversationIds = contacts.map((c) => c.conversationId).filter((id): id is string => Boolean(id));
  for (const ids of chunk(conversationIds)) {
    const states = await prisma.aiConversationState.findMany({
      where: { conversationId: { in: ids } },
      select: { conversationId: true, handoffState: true },
    });
    const byConversation = new Map(states.map((s) => [s.conversationId, s.handoffState as string]));
    for (const contact of contacts) {
      if (contact.conversationId && byConversation.has(contact.conversationId)) {
        facts.get(contact.id)!.handoffState = byConversation.get(contact.conversationId) ?? null;
      }
    }
  }

  for (const ids of chunk(contacts.map((c) => c.id))) {
    const sent = await prisma.crmBroadcastRecipient.findMany({
      where: {
        contactId: { in: ids },
        sentAt: { not: null },
        ...(excludeBroadcastId ? { broadcastId: { not: excludeBroadcastId } } : {}),
      },
      select: { contactId: true, sentAt: true },
    });
    for (const row of sent) {
      const fact = facts.get(row.contactId);
      if (!fact || !row.sentAt) continue;
      if (!fact.lastBroadcastSentAt || row.sentAt > fact.lastBroadcastSentAt) fact.lastBroadcastSentAt = row.sentAt;
    }
  }
  return facts;
}

async function workspaceSuspended(workspaceId: string): Promise<boolean> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { isSuspended: true } });
  return Boolean(ws?.isSuspended);
}

function evaluateOne(
  contact: ContactLite,
  fact: ContactFacts,
  env: { now: Date; suspended: boolean; tokenStatus: string | null; frequencyCapHours: number }
): RecipientEvaluation {
  return evaluateRecipient({
    now: env.now,
    workspaceSuspended: env.suspended,
    tokenStatus: env.tokenStatus,
    lastInboundAt: contact.lastInboundAt,
    optedOutAt: contact.optedOutAt,
    lastBroadcastSentAt: fact.lastBroadcastSentAt,
    frequencyCapHours: env.frequencyCapHours,
    handoffState: fact.handoffState,
    alreadyInBroadcast: false,
  });
}

/** Contacts of the account that match the filter (merged contacts excluded), oldest first. */
async function loadAudience(
  workspaceId: string,
  instagramAccountId: string,
  filter: SegmentFilter,
  now: Date,
  take = AUDIENCE_MAX
): Promise<ContactLite[]> {
  const where = {
    workspaceId,
    instagramAccountId,
    mergedIntoId: null,
    ...compileSegmentWhere(filter, now),
  } as Prisma.CrmContactWhereInput;
  return prisma.crmContact.findMany({ where, select: CONTACT_SELECT, orderBy: { createdAt: "asc" }, take });
}

// ─── Activities ───────────────────────────────────────────────────────────────

type BroadcastActivityType = "BROADCAST_SENT" | "BROADCAST_SKIPPED" | "BROADCAST_REPLIED" | "BROADCAST_CONVERTED" | "OPT_OUT";

/** Idempotent on (sourceTable, sourceId, type): a retried tick never doubles a row. */
async function recordBroadcastActivity(input: {
  workspaceId: string;
  contactId: string;
  dealId?: string | null;
  type: BroadcastActivityType;
  occurredAt: Date;
  title: string;
  body?: string | null;
  payload?: Record<string, unknown>;
  sourceTable: string;
  sourceId: string;
}): Promise<void> {
  try {
    await prisma.crmActivity.create({
      data: {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        dealId: input.dealId ?? null,
        type: input.type,
        occurredAt: input.occurredAt,
        actorKind: "SYSTEM",
        title: input.title,
        body: input.body ?? null,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        sourceTable: input.sourceTable,
        sourceId: input.sourceId,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

// ─── Create / update / list / get ─────────────────────────────────────────────

async function resolveFilter(
  workspaceId: string,
  input: { segmentId?: string | null; audienceFilter?: SegmentFilter | null }
): Promise<ServiceResult<{ segmentId: string | null; filter: SegmentFilter }>> {
  if (input.segmentId) {
    const segment = await segmentOf(workspaceId, input.segmentId);
    if (!segment) return fail(404, SEGMENT_NOT_FOUND);
    const filter = input.audienceFilter ?? parseSegmentFilter(segment.filter) ?? EMPTY_FILTER;
    return done({ segmentId: segment.id, filter });
  }
  return done({ segmentId: null, filter: input.audienceFilter ?? EMPTY_FILTER });
}

function scheduledAtOf(value: string | null | undefined, now: Date): ServiceResult<Date | null> {
  if (!value) return done(null);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return fail(400, "Sana noto'g'ri");
  if (at.getTime() < now.getTime() - 60_000) return fail(422, "Rejalashtirilgan vaqt o'tib ketgan");
  return done(at);
}

export async function createBroadcast(
  workspaceId: string,
  input: BroadcastInput,
  createdByUserId: string | null = null,
  now = new Date()
): Promise<ServiceResult<BroadcastView>> {
  const account = await accountOf(workspaceId, input.instagramAccountId);
  if (!account) return fail(404, ACCOUNT_NOT_FOUND);
  const audience = await resolveFilter(workspaceId, input);
  if (!audience.ok) return audience;
  const scheduledAt = scheduledAtOf(input.scheduledAt, now);
  if (!scheduledAt.ok) return scheduledAt;

  const row = await prisma.crmBroadcast.create({
    data: {
      workspaceId,
      instagramAccountId: account.id,
      name: input.name,
      segmentId: audience.data.segmentId,
      audienceFilter: audience.data.filter as unknown as Prisma.InputJsonValue,
      message: input.message,
      quickReplies: (input.quickReplies ?? []) as Prisma.InputJsonValue,
      status: "DRAFT",
      scheduledAt: scheduledAt.data,
      throttlePerHour: input.throttlePerHour ?? DEFAULT_BROADCAST.throttlePerHour,
      frequencyCapHours: input.frequencyCapHours ?? DEFAULT_BROADCAST.frequencyCapHours,
      replyWindowHours: input.replyWindowHours ?? DEFAULT_BROADCAST.replyWindowHours,
      conversionWindowDays: input.conversionWindowDays ?? DEFAULT_BROADCAST.conversionWindowDays,
      // Explicit zeros: the same as the column defaults, and visible to the in-memory test database.
      totalCount: 0,
      eligibleCount: 0,
      sentCount: 0,
      skippedCount: 0,
      failedCount: 0,
      repliedCount: 0,
      convertedCount: 0,
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdByUserId,
    },
  });
  return getBroadcast(workspaceId, row.id);
}

/** Only a DRAFT is editable; schedule it again after changes. */
export async function updateBroadcast(
  workspaceId: string,
  id: string,
  input: BroadcastUpdate,
  now = new Date()
): Promise<ServiceResult<BroadcastView>> {
  const row = await broadcastOf(workspaceId, id);
  if (!row) return fail(404, BROADCAST_NOT_FOUND);
  if (row.status !== "DRAFT") return fail(422, "Faqat qoralama tahrirlanadi — avval to'xtating yoki yangi broadcast yarating");

  const data: Prisma.CrmBroadcastUpdateInput = {};
  if (input.instagramAccountId !== undefined) {
    const account = await accountOf(workspaceId, input.instagramAccountId);
    if (!account) return fail(404, ACCOUNT_NOT_FOUND);
    data.instagramAccountId = account.id;
  }
  if (input.segmentId !== undefined || input.audienceFilter !== undefined) {
    const audience = await resolveFilter(workspaceId, {
      segmentId: input.segmentId === undefined ? row.segmentId : input.segmentId,
      audienceFilter: input.audienceFilter === undefined ? (input.segmentId ? null : filterOf(row)) : input.audienceFilter,
    });
    if (!audience.ok) return audience;
    data.segment = audience.data.segmentId ? { connect: { id: audience.data.segmentId } } : { disconnect: true };
    data.audienceFilter = audience.data.filter as unknown as Prisma.InputJsonValue;
  }
  if (input.scheduledAt !== undefined) {
    const scheduledAt = scheduledAtOf(input.scheduledAt, now);
    if (!scheduledAt.ok) return scheduledAt;
    data.scheduledAt = scheduledAt.data;
  }
  if (input.name !== undefined) data.name = input.name;
  if (input.message !== undefined) data.message = input.message;
  if (input.quickReplies !== undefined) data.quickReplies = input.quickReplies as Prisma.InputJsonValue;
  if (input.throttlePerHour !== undefined) data.throttlePerHour = input.throttlePerHour;
  if (input.frequencyCapHours !== undefined) data.frequencyCapHours = input.frequencyCapHours;
  if (input.replyWindowHours !== undefined) data.replyWindowHours = input.replyWindowHours;
  if (input.conversionWindowDays !== undefined) data.conversionWindowDays = input.conversionWindowDays;

  await prisma.crmBroadcast.update({ where: { id: row.id }, data });
  return getBroadcast(workspaceId, row.id);
}

async function pendingCount(broadcastId: string, status: CrmBroadcastStatus): Promise<number> {
  if (status === "DRAFT" || status === "SCHEDULED") return 0;
  return prisma.crmBroadcastRecipient.count({ where: { broadcastId, status: { in: ["PENDING", "SENDING"] } } });
}

export async function listBroadcasts(workspaceId: string, limit = 100): Promise<BroadcastView[]> {
  const rows = await prisma.crmBroadcast.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: limit });
  if (rows.length === 0) return [];
  const [accounts, segments] = await Promise.all([
    prisma.instagramAccount.findMany({ where: { workspaceId }, select: { id: true, username: true } }),
    prisma.crmSegment.findMany({ where: { workspaceId }, select: { id: true, name: true } }),
  ]);
  const accountName = new Map(accounts.map((a) => [a.id, a.username]));
  const segmentName = new Map(segments.map((s) => [s.id, s.name]));
  return Promise.all(
    rows.map(async (row) =>
      toView(row, {
        accountUsername: accountName.get(row.instagramAccountId) ?? null,
        segmentName: row.segmentId ? (segmentName.get(row.segmentId) ?? null) : null,
        pending: await pendingCount(row.id, row.status),
      })
    )
  );
}

export async function getBroadcast(workspaceId: string, id: string): Promise<ServiceResult<BroadcastView>> {
  const row = await broadcastOf(workspaceId, id);
  if (!row) return fail(404, BROADCAST_NOT_FOUND);
  const [account, segment, pending] = await Promise.all([
    prisma.instagramAccount.findUnique({ where: { id: row.instagramAccountId }, select: { username: true } }),
    row.segmentId ? prisma.crmSegment.findUnique({ where: { id: row.segmentId }, select: { name: true } }) : null,
    pendingCount(row.id, row.status),
  ]);
  return done(toView(row, { accountUsername: account?.username ?? null, segmentName: segment?.name ?? null, pending }));
}

export async function listRecipients(workspaceId: string, id: string, query: RecipientsQuery = {}): Promise<ServiceResult<RecipientsPage>> {
  const row = await broadcastOf(workspaceId, id);
  if (!row) return fail(404, BROADCAST_NOT_FOUND);
  const limit = query.limit ?? 50;
  const offset = query.cursor ?? 0;
  const where: Prisma.CrmBroadcastRecipientWhereInput = {
    broadcastId: row.id,
    ...(query.status ? { status: query.status } : {}),
    ...(query.reason ? { ineligibleReason: query.reason } : {}),
    ...(query.replied === true ? { repliedAt: { not: null } } : {}),
  };
  const [rows, all] = await Promise.all([
    prisma.crmBroadcastRecipient.findMany({ where, orderBy: { createdAt: "asc" }, skip: offset, take: limit + 1 }),
    prisma.crmBroadcastRecipient.findMany({ where: { broadcastId: row.id }, select: { status: true, ineligibleReason: true } }),
  ]);
  const page = rows.slice(0, limit);
  const contactIds = Array.from(new Set(page.map((r) => r.contactId)));
  const contacts = contactIds.length
    ? await prisma.crmContact.findMany({ where: { id: { in: contactIds } }, select: { id: true, username: true, name: true } })
    : [];
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const byStatus: Record<CrmRecipientStatus, number> = { PENDING: 0, SENDING: 0, SENT: 0, SKIPPED: 0, FAILED: 0 };
  const reasonCounts = new Map<IneligibilityReason, number>();
  for (const r of all) {
    byStatus[r.status]++;
    const reason = reasonOf(r.ineligibleReason);
    if (reason) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  return done({
    recipients: page.map((r) => {
      const contact = contactById.get(r.contactId);
      const reason = reasonOf(r.ineligibleReason);
      return {
        id: r.id,
        contactId: r.contactId,
        username: contact?.username ?? null,
        name: contact?.name ?? null,
        status: r.status,
        statusLabel: RECIPIENT_STATUS_LABELS[r.status],
        eligible: r.eligible,
        reason,
        reasonLabel: reason ? INELIGIBILITY_LABELS[reason] : null,
        attempts: r.attempts,
        sentAt: r.sentAt,
        error: r.error,
        repliedAt: r.repliedAt,
        convertedAt: r.convertedAt,
        conversionDealId: r.conversionDealId,
      };
    }),
    nextCursor: rows.length > limit ? offset + limit : null,
    byStatus,
    byReason: INELIGIBILITY_REASONS.filter((reason) => reasonCounts.has(reason)).map((reason) => ({
      reason,
      label: INELIGIBILITY_LABELS[reason],
      count: reasonCounts.get(reason)!,
    })),
  });
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export type PreviewSource = { broadcastId: string } | PreviewInput;

/**
 * Who would get the broadcast right now, and why not. Counts are exact; the
 * per-recipient evaluation stops at PREVIEW_EVALUATE_MAX contacts.
 */
export async function previewAudience(workspaceId: string, source: PreviewSource, now = new Date()): Promise<ServiceResult<AudiencePreview>> {
  let instagramAccountId: string;
  let filter: SegmentFilter;
  let frequencyCapHours: number;
  let excludeBroadcastId: string | null = null;

  if ("broadcastId" in source) {
    const row = await broadcastOf(workspaceId, source.broadcastId);
    if (!row) return fail(404, BROADCAST_NOT_FOUND);
    instagramAccountId = row.instagramAccountId;
    filter = filterOf(row);
    frequencyCapHours = row.frequencyCapHours;
    excludeBroadcastId = row.id;
  } else {
    const audience = await resolveFilter(workspaceId, source);
    if (!audience.ok) return audience;
    instagramAccountId = source.instagramAccountId;
    filter = audience.data.filter;
    frequencyCapHours = source.frequencyCapHours ?? DEFAULT_BROADCAST.frequencyCapHours;
  }

  const account = await accountOf(workspaceId, instagramAccountId);
  if (!account) return fail(404, ACCOUNT_NOT_FOUND);

  const contacts = await loadAudience(workspaceId, account.id, filter, now, PREVIEW_EVALUATE_MAX + 1);
  const truncated = contacts.length > PREVIEW_EVALUATE_MAX;
  const evaluatedContacts = truncated ? contacts.slice(0, PREVIEW_EVALUATE_MAX) : contacts;
  const total = truncated
    ? await prisma.crmContact.count({
        where: { workspaceId, instagramAccountId: account.id, mergedIntoId: null, ...compileSegmentWhere(filter, now) } as Prisma.CrmContactWhereInput,
      })
    : contacts.length;

  const [suspended, facts] = await Promise.all([workspaceSuspended(workspaceId), loadFacts(evaluatedContacts, excludeBroadcastId)]);
  const env = { now, suspended, tokenStatus: account.tokenStatus, frequencyCapHours };
  const evaluations = evaluatedContacts.map((contact) => evaluateOne(contact, facts.get(contact.id)!, env));
  const summary = summarizeEligibility(evaluations);

  return done({
    total,
    eligibleNow: summary.eligible,
    evaluated: evaluatedContacts.length,
    byReason: INELIGIBILITY_REASONS.filter((reason) => summary.byReason[reason] > 0).map((reason) => ({
      reason,
      label: INELIGIBILITY_LABELS[reason],
      count: summary.byReason[reason],
    })),
    sample: evaluatedContacts.slice(0, PREVIEW_SAMPLE).map((contact, i) => ({
      contactId: contact.id,
      username: contact.username,
      name: contact.name,
      eligible: evaluations[i].eligible,
      reason: evaluations[i].reason ?? null,
      label: evaluations[i].label ?? null,
      windowClosesAt: windowClosesAt(contact.lastInboundAt),
    })),
  });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export async function scheduleBroadcast(
  workspaceId: string,
  id: string,
  input: { scheduledAt?: string | null } = {},
  now = new Date()
): Promise<ServiceResult<BroadcastView>> {
  const row = await broadcastOf(workspaceId, id);
  if (!row) return fail(404, BROADCAST_NOT_FOUND);
  if (row.status !== "DRAFT") return fail(422, `Broadcast allaqachon ${BROADCAST_STATUS_LABELS[row.status].toLowerCase()}`);
  const account = await accountOf(workspaceId, row.instagramAccountId);
  if (!account) return fail(404, ACCOUNT_NOT_FOUND);
  if (account.tokenStatus !== "ACTIVE") return fail(422, "Instagram ulanishi uzilgan — avval akkauntni qayta ulang");

  const parsed = scheduledAtOf(input.scheduledAt === undefined ? (row.scheduledAt ? row.scheduledAt.toISOString() : null) : input.scheduledAt, now);
  if (!parsed.ok) return parsed;
  const at = parsed.data ?? now;

  // Snapshot of the segment filter at schedule time.
  let audienceFilter = filterOf(row);
  if (row.segmentId) {
    const segment = await segmentOf(workspaceId, row.segmentId);
    if (!segment) return fail(404, SEGMENT_NOT_FOUND);
    audienceFilter = parseSegmentFilter(segment.filter) ?? EMPTY_FILTER;
  }

  const claimed = await prisma.crmBroadcast.updateMany({
    where: { id: row.id, status: "DRAFT" },
    data: { status: "SCHEDULED", scheduledAt: at, audienceFilter: audienceFilter as unknown as Prisma.InputJsonValue, lastError: null },
  });
  if (claimed.count === 0) return fail(409, "Broadcast holati o'zgarib ketdi — sahifani yangilang");
  await enqueueBroadcastStart(row.id, Math.max(0, at.getTime() - now.getTime()), at);
  return getBroadcast(workspaceId, row.id);
}

export async function pauseBroadcast(workspaceId: string, id: string): Promise<ServiceResult<BroadcastView>> {
  const row = await broadcastOf(workspaceId, id);
  if (!row) return fail(404, BROADCAST_NOT_FOUND);
  if (row.status !== "SCHEDULED" && row.status !== "RUNNING") return fail(422, "Faqat rejalashtirilgan yoki yuborilayotgan broadcast to'xtatiladi");
  const claimed = await prisma.crmBroadcast.updateMany({ where: { id: row.id, status: row.status }, data: { status: "PAUSED" } });
  if (claimed.count === 0) return fail(409, "Broadcast holati o'zgarib ketdi — sahifani yangilang");
  await removeBroadcastJobs(row.id).catch(() => {});
  return getBroadcast(workspaceId, row.id);
}

export async function resumeBroadcast(workspaceId: string, id: string, now = new Date()): Promise<ServiceResult<BroadcastView>> {
  const row = await broadcastOf(workspaceId, id);
  if (!row) return fail(404, BROADCAST_NOT_FOUND);
  if (row.status !== "PAUSED") return fail(422, "Faqat to'xtatilgan broadcast davom ettiriladi");
  if (!row.startedAt) {
    // Paused before it started: back to the schedule.
    const at = row.scheduledAt && row.scheduledAt > now ? row.scheduledAt : now;
    const claimed = await prisma.crmBroadcast.updateMany({ where: { id: row.id, status: "PAUSED" }, data: { status: "SCHEDULED", scheduledAt: at } });
    if (claimed.count === 0) return fail(409, "Broadcast holati o'zgarib ketdi — sahifani yangilang");
    await enqueueBroadcastStart(row.id, Math.max(0, at.getTime() - now.getTime()), at);
    return getBroadcast(workspaceId, row.id);
  }
  const claimed = await prisma.crmBroadcast.updateMany({ where: { id: row.id, status: "PAUSED" }, data: { status: "RUNNING", lastError: null } });
  if (claimed.count === 0) return fail(409, "Broadcast holati o'zgarib ketdi — sahifani yangilang");
  // A new tick number: a tick still running from before the pause sees it and stops (one chain).
  await scheduleTick(row.id, 0, now);
  return getBroadcast(workspaceId, row.id);
}

export async function cancelBroadcast(workspaceId: string, id: string, now = new Date()): Promise<ServiceResult<BroadcastView>> {
  const row = await broadcastOf(workspaceId, id);
  if (!row) return fail(404, BROADCAST_NOT_FOUND);
  if (row.status === "COMPLETED" || row.status === "CANCELLED" || row.status === "FAILED") {
    return fail(422, `Broadcast allaqachon ${BROADCAST_STATUS_LABELS[row.status].toLowerCase()}`);
  }
  const claimed = await prisma.crmBroadcast.updateMany({
    where: { id: row.id, status: row.status },
    data: { status: "CANCELLED", completedAt: now },
  });
  if (claimed.count === 0) return fail(409, "Broadcast holati o'zgarib ketdi — sahifani yangilang");
  await removeBroadcastJobs(row.id).catch(() => {});
  // Rows a running tick already leased (SENDING) are skipped by that tick when it sees CANCELLED.
  const left = await prisma.crmBroadcastRecipient.updateMany({
    where: { broadcastId: row.id, status: "PENDING" },
    data: { status: "SKIPPED", error: CANCELLED_ERROR },
  });
  if (left.count > 0) await prisma.crmBroadcast.update({ where: { id: row.id }, data: { skippedCount: { increment: left.count } } });
  return getBroadcast(workspaceId, row.id);
}

// ─── Start: materialise the audience ──────────────────────────────────────────

export interface StartResult {
  started: boolean;
  total: number;
  eligible: number;
  skipped: number;
}

/** SCHEDULED → RUNNING. Creates one recipient per contact with its eligibility snapshot and enqueues the first batch. */
export async function startBroadcast(broadcastId: string, now = new Date()): Promise<StartResult> {
  const claimed = await prisma.crmBroadcast.updateMany({
    where: { id: broadcastId, status: "SCHEDULED" },
    data: { status: "RUNNING", startedAt: now, lastError: null },
  });
  if (claimed.count === 0) return { started: false, total: 0, eligible: 0, skipped: 0 };
  const broadcast = await prisma.crmBroadcast.findUniqueOrThrow({ where: { id: broadcastId } });

  try {
    const account = await prisma.instagramAccount.findUnique({ where: { id: broadcast.instagramAccountId } });
    if (!account) throw new Error(ACCOUNT_NOT_FOUND);

    const audience = await loadAudience(broadcast.workspaceId, account.id, filterOf(broadcast), now);
    const existing = new Set(
      (await prisma.crmBroadcastRecipient.findMany({ where: { broadcastId }, select: { contactId: true } })).map((r) => r.contactId)
    );
    const fresh = audience.filter((contact) => !existing.has(contact.id));

    const [suspended, facts] = await Promise.all([workspaceSuspended(broadcast.workspaceId), loadFacts(fresh, broadcastId)]);
    const env = { now, suspended, tokenStatus: account.tokenStatus as string, frequencyCapHours: broadcast.frequencyCapHours };
    const evaluations = fresh.map((contact) => evaluateOne(contact, facts.get(contact.id)!, env));

    for (const part of chunk(fresh.map((contact, i) => ({ contact, evaluation: evaluations[i] })))) {
      await prisma.crmBroadcastRecipient.createMany({
        data: part.map(({ contact, evaluation }) => ({
          broadcastId,
          contactId: contact.id,
          eligible: evaluation.eligible,
          ineligibleReason: evaluation.reason ?? null,
          eligibilitySnapshot: evaluation.snapshot as unknown as Prisma.InputJsonValue,
          status: evaluation.eligible ? ("PENDING" as const) : ("SKIPPED" as const),
          error: evaluation.eligible ? null : (evaluation.label ?? null),
          attempts: 0,
          sentMessageId: null,
          sentAt: null,
          repliedAt: null,
          replyMessageId: null,
          convertedAt: null,
          conversionDealId: null,
        })),
        skipDuplicates: true,
      });
    }

    const eligible = evaluations.filter((e) => e.eligible).length;
    const skipped = fresh.length - eligible;

    // Timeline rows for the people who were not reached, with the reason.
    const skippedRows = skipped
      ? await prisma.crmBroadcastRecipient.findMany({ where: { broadcastId, status: "SKIPPED" }, select: { id: true, contactId: true, ineligibleReason: true } })
      : [];
    for (const r of skippedRows) {
      const reason = reasonOf(r.ineligibleReason);
      await recordBroadcastActivity({
        workspaceId: broadcast.workspaceId,
        contactId: r.contactId,
        type: "BROADCAST_SKIPPED",
        occurredAt: now,
        title: `Broadcast o'tkazildi: ${broadcast.name}`,
        body: reason ? INELIGIBILITY_LABELS[reason] : null,
        payload: { broadcastId, reason },
        sourceTable: "CrmBroadcastRecipient",
        sourceId: r.id,
      });
    }

    await prisma.crmBroadcast.update({
      where: { id: broadcastId },
      data: {
        totalCount: { increment: fresh.length },
        eligibleCount: { increment: eligible },
        skippedCount: { increment: skipped },
        ...(eligible === 0 ? { status: "COMPLETED", completedAt: now } : {}),
      },
    });
    if (eligible > 0) await scheduleTick(broadcastId, 0, now);
    else void emitBroadcastCompleted(broadcastId);
    return { started: true, total: fresh.length, eligible, skipped };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.crmBroadcast
      .update({ where: { id: broadcastId }, data: { status: "FAILED", lastError: `Boshlashda xatolik: ${message}`.slice(0, 500), completedAt: now } })
      .catch(() => {});
    throw error;
  }
}

// ─── Batch delivery ───────────────────────────────────────────────────────────

export interface BatchResult {
  /** stopped: paused / cancelled; rate_limited: waits past the hour; completed: nothing left; continue: next batch in 5 min. */
  outcome: "stopped" | "rate_limited" | "completed" | "continue";
  sent: number;
  skipped: number;
  failed: number;
  /** Put back to PENDING for a later batch. */
  requeued: number;
  remaining: number;
}

/** `{ism}` → the person's name (or username). */
export function renderBroadcastMessage(template: string, contact: { name: string | null; username: string | null }): string {
  const who = contact.name?.trim() || (contact.username ? `@${contact.username}` : "");
  return template.replace(/\{(ism|name)\}/gi, who).replace(/[ \t]+([,.!?])/g, "$1").trim();
}

function quickReplyOptions(broadcastId: string, titles: string[]): QuickReplyOption[] {
  return titles.map((title, i) => ({ title, payload: `crm_bc_${broadcastId}_${i}`, contentType: "text" as const }));
}

/**
 * Reserve the next tick of the delivery chain on the row and enqueue it as
 * job bcb_<id>_<tickSeq>. With `expectedSeq` (a tick scheduling its
 * successor, the maintenance sweep) only when the row is still on that
 * number and RUNNING — otherwise another chain owns the broadcast and this
 * one ends. Without it (start, resume) the number is bumped unconditionally,
 * which retires any older chain. False when nothing was scheduled.
 */
export async function scheduleTick(broadcastId: string, delayMs: number, now: Date, expectedSeq?: number): Promise<boolean> {
  const nextTickAt = new Date(now.getTime() + Math.max(0, delayMs));
  let seq: number;
  if (expectedSeq === undefined) {
    const row = await prisma.crmBroadcast.update({ where: { id: broadcastId }, data: { tickSeq: { increment: 1 }, nextTickAt } });
    seq = row.tickSeq;
  } else {
    const moved = await prisma.crmBroadcast.updateMany({
      where: { id: broadcastId, tickSeq: expectedSeq, status: "RUNNING" },
      data: { tickSeq: expectedSeq + 1, nextTickAt },
    });
    if (moved.count === 0) return false;
    seq = expectedSeq + 1;
  }
  await enqueueBroadcastBatch(broadcastId, delayMs, seq);
  return true;
}

/** Cancel arrived while this tick held the lease: the row is skipped, never released back to PENDING. */
async function cancelLeased(broadcastId: string, recipientId: string): Promise<boolean> {
  const moved = await prisma.crmBroadcastRecipient.updateMany({
    where: { id: recipientId, status: "SENDING" },
    data: { status: "SKIPPED", error: CANCELLED_ERROR },
  });
  if (moved.count === 0) return false;
  await prisma.crmBroadcast.update({ where: { id: broadcastId }, data: { skippedCount: { increment: 1 } } });
  return true;
}

async function releaseRecipient(id: string, note: string | null, countAttempt: boolean): Promise<void> {
  await prisma.crmBroadcastRecipient.updateMany({
    where: { id, status: "SENDING" },
    data: { status: "PENDING", error: note, ...(countAttempt ? {} : { attempts: { decrement: 1 } }) },
  });
}

/**
 * One delivery tick. `tickSeq` (from the job) must still be the row's
 * number, otherwise a newer chain owns the broadcast and this job ends
 * without sending; null (direct calls) adopts the current number.
 */
export async function runBroadcastBatch(broadcastId: string, now = new Date(), tickSeq: number | null = null): Promise<BatchResult> {
  const result: BatchResult = { outcome: "stopped", sent: 0, skipped: 0, failed: 0, requeued: 0, remaining: 0 };
  const broadcast = await prisma.crmBroadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast || broadcast.status !== "RUNNING") return result;
  if (tickSeq !== null && broadcast.tickSeq !== tickSeq) return result; // a stale chain
  const mySeq = broadcast.tickSeq;

  // A worker that died mid-send: Instagram may or may not have delivered it.
  const stale = await prisma.crmBroadcastRecipient.updateMany({
    where: { broadcastId, status: "SENDING", updatedAt: { lt: new Date(now.getTime() - SENDING_LEASE_MS) } },
    data: { status: "FAILED", error: STALE_SENDING_ERROR },
  });
  if (stale.count > 0) {
    await prisma.crmBroadcast.update({ where: { id: broadcastId }, data: { failedCount: { increment: stale.count } } });
    result.failed += stale.count;
  }

  const size = batchSize(broadcast.throttlePerHour, BROADCAST_BATCH_INTERVAL_MS / 60_000);
  const candidates = await prisma.crmBroadcastRecipient.findMany({
    where: { broadcastId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: size,
    select: { id: true },
  });
  const leased: string[] = [];
  for (const { id } of candidates) {
    const claimed = await prisma.crmBroadcastRecipient.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "SENDING", attempts: { increment: 1 } },
    });
    if (claimed.count === 1) leased.push(id);
  }

  let halt: "rate_limit" | "stopped" | "cancelled" | null = null;
  if (leased.length > 0) {
    const recipients = await prisma.crmBroadcastRecipient.findMany({ where: { id: { in: leased } }, orderBy: { createdAt: "asc" } });
    const contacts = await prisma.crmContact.findMany({ where: { id: { in: recipients.map((r) => r.contactId) } }, select: CONTACT_SELECT });
    const contactById = new Map(contacts.map((c) => [c.id, c]));
    const account = await prisma.instagramAccount.findUnique({ where: { id: broadcast.instagramAccountId } });
    const [suspended, facts] = await Promise.all([workspaceSuspended(broadcast.workspaceId), loadFacts(contacts, broadcastId)]);
    const env = { now, suspended, tokenStatus: account?.tokenStatus ?? null, frequencyCapHours: broadcast.frequencyCapHours };
    const token = account ? readAccessToken(account) : null;
    const titles = quickRepliesOf(broadcast);

    for (const recipient of recipients) {
      if (!halt) {
        const current = await prisma.crmBroadcast.findUnique({ where: { id: broadcastId }, select: { status: true, tickSeq: true } });
        if (current?.status === "CANCELLED") halt = "cancelled";
        // Paused, or resumed meanwhile (a newer tick number owns the chain): stop and hand the lease back.
        else if (current?.status !== "RUNNING" || current.tickSeq !== mySeq) halt = "stopped";
      }
      if (halt === "cancelled") {
        if (await cancelLeased(broadcastId, recipient.id)) result.skipped++;
        continue;
      }
      if (halt) {
        await releaseRecipient(recipient.id, null, false);
        result.requeued++;
        continue;
      }

      const contact = contactById.get(recipient.contactId);
      if (!contact || !account) {
        await failRecipient(broadcast, recipient, contact ? ACCOUNT_NOT_FOUND : "Kontakt topilmadi", now);
        result.failed++;
        continue;
      }

      // Eligibility may have changed since the snapshot (opt-out, handoff, window).
      const evaluation = evaluateOne(contact, facts.get(contact.id)!, env);
      if (!evaluation.eligible) {
        await skipRecipient(broadcast, recipient, evaluation, now);
        result.skipped++;
        continue;
      }
      if (!token || !token.ok) {
        await failRecipient(broadcast, recipient, token ? token.failure.userMessage : ACCOUNT_NOT_FOUND, now);
        result.failed++;
        continue;
      }

      const text = renderBroadcastMessage(broadcast.message, contact);
      const accessToken = token.token;
      const send = await sendGuarded(broadcast.workspaceId, account, () =>
        titles.length > 0
          ? sendDirectMessageWithQuickReplies(accessToken, account.instagramId, contact.igUserId, text, quickReplyOptions(broadcastId, titles))
          : sendDirectMessage(accessToken, account.instagramId, contact.igUserId, text)
      );

      if (send.ok) {
        await markSent(broadcast, recipient, contact, text, send.sent.message_id ?? null, new Date());
        result.sent++;
        continue;
      }
      if (send.skipped) {
        await failRecipient(broadcast, recipient, send.error, now);
        await prisma.crmBroadcast.update({ where: { id: broadcastId }, data: { lastError: send.error } }).catch(() => {});
        result.failed++;
        continue;
      }
      if (send.failure.kind === "rate_limit") {
        halt = "rate_limit";
        await releaseRecipient(recipient.id, send.failure.userMessage, false);
        result.requeued++;
        continue;
      }
      if (send.failure.retryable && recipient.attempts < MAX_SEND_ATTEMPTS) {
        await releaseRecipient(recipient.id, send.failure.userMessage, true);
        result.requeued++;
        continue;
      }
      await failRecipient(broadcast, recipient, send.failure.userMessage, now);
      result.failed++;
    }
  }

  if (halt === "stopped" || halt === "cancelled") return result;

  result.remaining = await prisma.crmBroadcastRecipient.count({ where: { broadcastId, status: { in: ["PENDING", "SENDING"] } } });
  if (halt === "rate_limit") {
    await prisma.crmBroadcast.update({ where: { id: broadcastId }, data: { lastError: RATE_LIMIT_NOTE } }).catch(() => {});
    await scheduleTick(broadcastId, TRIGGER_RATE_LIMIT_BACKOFF_MS, now, mySeq);
    return { ...result, outcome: "rate_limited" };
  }
  if (result.remaining === 0) {
    const completed = await prisma.crmBroadcast.updateMany({ where: { id: broadcastId, status: "RUNNING" }, data: { status: "COMPLETED", completedAt: new Date() } });
    if (completed.count === 1) void emitBroadcastCompleted(broadcastId);
    return { ...result, outcome: "completed" };
  }
  await scheduleTick(broadcastId, BROADCAST_BATCH_INTERVAL_MS, now, mySeq);
  return { ...result, outcome: "continue" };
}

async function skipRecipient(broadcast: CrmBroadcast, recipient: CrmBroadcastRecipient, evaluation: RecipientEvaluation, now: Date) {
  await prisma.crmBroadcastRecipient.update({
    where: { id: recipient.id },
    data: {
      status: "SKIPPED",
      eligible: false,
      ineligibleReason: evaluation.reason ?? null,
      eligibilitySnapshot: evaluation.snapshot as unknown as Prisma.InputJsonValue,
      error: evaluation.label ?? null,
    },
  });
  await prisma.crmBroadcast.update({ where: { id: broadcast.id }, data: { skippedCount: { increment: 1 } } });
  await recordBroadcastActivity({
    workspaceId: broadcast.workspaceId,
    contactId: recipient.contactId,
    type: "BROADCAST_SKIPPED",
    occurredAt: now,
    title: `Broadcast o'tkazildi: ${broadcast.name}`,
    body: evaluation.label ?? null,
    payload: { broadcastId: broadcast.id, reason: evaluation.reason ?? null },
    sourceTable: "CrmBroadcastRecipient",
    sourceId: recipient.id,
  });
}

async function failRecipient(broadcast: CrmBroadcast, recipient: CrmBroadcastRecipient, error: string, _now: Date) {
  void _now;
  await prisma.crmBroadcastRecipient.update({ where: { id: recipient.id }, data: { status: "FAILED", error: error.slice(0, 500) } });
  await prisma.crmBroadcast.update({ where: { id: broadcast.id }, data: { failedCount: { increment: 1 } } });
}

async function markSent(
  broadcast: CrmBroadcast,
  recipient: CrmBroadcastRecipient,
  contact: ContactLite,
  text: string,
  mid: string | null,
  sentAt: Date
) {
  await prisma.crmBroadcastRecipient.update({
    where: { id: recipient.id },
    data: { status: "SENT", sentAt, sentMessageId: mid, error: null },
  });
  await prisma.crmBroadcast.update({ where: { id: broadcast.id }, data: { sentCount: { increment: 1 } } });
  await prisma.crmContact.update({ where: { id: contact.id }, data: { lastOutboundAt: sentAt, lastInteractionAt: sentAt } }).catch(() => {});
  if (contact.conversationId) {
    // handleEcho treats a stored mid as our own send, so the echo of this
    // DM never reads as an operator takeover.
    await prisma.conversationMessage
      .create({
        data: {
          conversationId: contact.conversationId,
          mid,
          author: "SYSTEM",
          text,
          llmMeta: { broadcastId: broadcast.id, recipientId: recipient.id, kind: "broadcast" },
        },
      })
      .catch(() => {});
  }
  await recordBroadcastActivity({
    workspaceId: broadcast.workspaceId,
    contactId: contact.id,
    type: "BROADCAST_SENT",
    occurredAt: sentAt,
    title: `Broadcast yuborildi: ${broadcast.name}`,
    body: text,
    payload: { broadcastId: broadcast.id, mid },
    sourceTable: "CrmBroadcastRecipient",
    sourceId: recipient.id,
  });
}

// ─── Attribution ──────────────────────────────────────────────────────────────

/** Newest SENT recipient of the contact whose window (hours or days) still covers `at`. */
async function attributableRecipient(
  contactId: string,
  at: Date,
  windowOf: (b: CrmBroadcast) => number,
  open: (r: CrmBroadcastRecipient) => boolean
): Promise<{ recipient: CrmBroadcastRecipient; broadcast: CrmBroadcast } | null> {
  const candidates = await prisma.crmBroadcastRecipient.findMany({
    where: { contactId, status: "SENT", sentAt: { not: null, lte: at } },
    orderBy: { sentAt: "desc" },
    take: 20,
  });
  const openOnes = candidates.filter(open);
  if (openOnes.length === 0) return null;
  const broadcasts = await prisma.crmBroadcast.findMany({ where: { id: { in: Array.from(new Set(openOnes.map((r) => r.broadcastId))) } } });
  const byId = new Map(broadcasts.map((b) => [b.id, b]));
  for (const recipient of openOnes) {
    const broadcast = byId.get(recipient.broadcastId);
    if (!broadcast || !recipient.sentAt) continue;
    if (at.getTime() - recipient.sentAt.getTime() <= windowOf(broadcast)) return { recipient, broadcast };
  }
  return null;
}

/** A customer message inside replyWindowHours after the send counts as a reply. Returns the recipient id or null. */
export async function attributeReply(contactId: string, at: Date, mid: string | null = null): Promise<string | null> {
  const hit = await attributableRecipient(
    contactId,
    at,
    (b) => b.replyWindowHours * 3600_000,
    (r) => r.repliedAt === null
  );
  if (!hit) return null;
  const { recipient, broadcast } = hit;
  const claimed = await prisma.crmBroadcastRecipient.updateMany({
    where: { id: recipient.id, repliedAt: null },
    data: { repliedAt: at, replyMessageId: mid },
  });
  if (claimed.count === 0) return null;
  await prisma.crmBroadcast.update({ where: { id: broadcast.id }, data: { repliedCount: { increment: 1 } } });
  await recordBroadcastActivity({
    workspaceId: broadcast.workspaceId,
    contactId,
    type: "BROADCAST_REPLIED",
    occurredAt: at,
    title: `Broadcast'ga javob berdi: ${broadcast.name}`,
    payload: { broadcastId: broadcast.id, mid },
    sourceTable: "CrmBroadcastRecipient",
    sourceId: recipient.id,
  });
  return recipient.id;
}

/** A deal created or advanced inside conversionWindowDays after the send counts as a conversion. */
export async function attributeConversion(contactId: string, dealId: string, at: Date): Promise<string | null> {
  const hit = await attributableRecipient(
    contactId,
    at,
    (b) => b.conversionWindowDays * 24 * 3600_000,
    (r) => r.convertedAt === null
  );
  if (!hit) return null;
  const { recipient, broadcast } = hit;
  const claimed = await prisma.crmBroadcastRecipient.updateMany({
    where: { id: recipient.id, convertedAt: null },
    data: { convertedAt: at, conversionDealId: dealId },
  });
  if (claimed.count === 0) return null;
  await prisma.crmBroadcast.update({ where: { id: broadcast.id }, data: { convertedCount: { increment: 1 } } });
  await recordBroadcastActivity({
    workspaceId: broadcast.workspaceId,
    contactId,
    dealId,
    type: "BROADCAST_CONVERTED",
    occurredAt: at,
    title: `Broadcast konversiyasi: ${broadcast.name}`,
    payload: { broadcastId: broadcast.id, dealId },
    sourceTable: "CrmBroadcastRecipient",
    sourceId: recipient.id,
  });
  return recipient.id;
}

const OPT_OUT_SOURCE = "CrmContactOptOut";

/** The opting-out message's identity: its mid, else its time. */
export function optOutSourceId(contactId: string, mid: string | null | undefined, at: Date): string {
  return mid ? `${contactId}_mid_${mid}` : `${contactId}_${at.getTime()}`;
}

/**
 * "stop" / "to'xtat" / "отпишите" → the contact is opted out of every future
 * broadcast. Each opting-out message is applied once: its identity (mid, else
 * time) is the OPT_OUT activity's sourceId, so a replay of the same message
 * (reconciler, retried job) after a manual opt-in does not opt the person out
 * again. A stop word while already opted out is recorded too, for the same reason.
 */
export async function handleOptOut(contactId: string, text: string | null | undefined, at: Date, mid: string | null = null): Promise<boolean> {
  if (!isOptOutMessage(text)) return false;
  const sourceId = optOutSourceId(contactId, mid, at);
  const seen = await prisma.crmActivity.findFirst({ where: { sourceTable: OPT_OUT_SOURCE, sourceId, type: "OPT_OUT" }, select: { id: true } });
  if (seen) return false;
  const contact = await prisma.crmContact.findUnique({ where: { id: contactId }, select: { workspaceId: true } });
  if (!contact) return false;
  const claimed = await prisma.crmContact.updateMany({
    where: { id: contactId, optedOutAt: null },
    data: { optedOutAt: at, optOutReason: "stop_word" },
  });
  await recordBroadcastActivity({
    workspaceId: contact.workspaceId,
    contactId,
    type: "OPT_OUT",
    occurredAt: at,
    title: claimed.count > 0 ? "Obunadan chiqdi" : "Obunadan chiqishni so'radi (allaqachon chiqarilgan)",
    body: (text ?? "").slice(0, 200),
    payload: { reason: "stop_word", mid },
    sourceTable: OPT_OUT_SOURCE,
    sourceId,
  });
  return claimed.count > 0;
}

/** Manual opt-out / opt-in from the contact drawer. */
export async function setOptOut(workspaceId: string, contactId: string, optedOut: boolean, reason = "manual"): Promise<ServiceResult<{ optedOutAt: Date | null }>> {
  const contact = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true, optedOutAt: true } });
  if (!contact) return fail(404, "Kontakt topilmadi");
  const at = new Date();
  if (optedOut && !contact.optedOutAt) {
    await prisma.crmContact.update({ where: { id: contact.id }, data: { optedOutAt: at, optOutReason: reason } });
    await recordBroadcastActivity({
      workspaceId,
      contactId: contact.id,
      type: "OPT_OUT",
      occurredAt: at,
      title: "Obunadan chiqarildi (qo'lda)",
      payload: { reason },
      sourceTable: OPT_OUT_SOURCE,
      sourceId: `${contact.id}_${at.getTime()}`,
    });
    return done({ optedOutAt: at });
  }
  if (!optedOut && contact.optedOutAt) {
    await prisma.crmContact.update({ where: { id: contact.id }, data: { optedOutAt: null, optOutReason: null } });
    return done({ optedOutAt: null });
  }
  return done({ optedOutAt: contact.optedOutAt });
}

/** Everything the engine wants to know about one inbound customer message (CRM "inbound" hook). */
export async function onBroadcastInbound(input: { contactId: string; text?: string | null; mid?: string | null; at?: Date }): Promise<{ optedOut: boolean; repliedRecipientId: string | null }> {
  const at = input.at ?? new Date();
  const optedOut = await handleOptOut(input.contactId, input.text, at, input.mid ?? null);
  const repliedRecipientId = await attributeReply(input.contactId, at, input.mid ?? null);
  return { optedOut, repliedRecipientId };
}

/** A deal was created or moved to another stage (CRM "deal" hook). */
export async function onBroadcastDealEvent(input: { contactId: string; dealId: string; at?: Date }): Promise<string | null> {
  return attributeConversion(input.contactId, input.dealId, input.at ?? new Date());
}

// ─── Maintenance (every minute from the worker) ───────────────────────────────

const SCHEDULED_GRACE_MS = 2 * 60_000;

export async function runBroadcastMaintenance(now = new Date()): Promise<{ started: number; requeued: number }> {
  const out = { started: 0, requeued: 0 };
  if (!isCrmEnabled()) return out;

  // Past due and still SCHEDULED: the start job was lost (Redis flush, crash).
  // Its job id is keyed on scheduledAt, so a start that is merely late is not doubled.
  const due = await prisma.crmBroadcast.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: new Date(now.getTime() - SCHEDULED_GRACE_MS) } },
    select: { id: true, scheduledAt: true },
    take: 50,
  });
  for (const row of due) {
    await enqueueBroadcastStart(row.id, 0, row.scheduledAt);
    out.started++;
  }

  // RUNNING with the next tick overdue by a whole interval: the chain is lost.
  // The row state decides (no queue scans); scheduleTick only wins on the
  // tick number it read, and the stale SENDING sweep inside the batch keeps a
  // half-sent tick from repeating.
  const running = await prisma.crmBroadcast.findMany({
    where: { status: "RUNNING" },
    select: { id: true, updatedAt: true, nextTickAt: true, tickSeq: true },
    take: 50,
  });
  for (const row of running) {
    const dueAt = (row.nextTickAt ?? row.updatedAt).getTime();
    if (now.getTime() - dueAt < BROADCAST_BATCH_INTERVAL_MS) continue;
    if (await scheduleTick(row.id, 0, now, row.tickSeq)) out.requeued++;
  }
  return out;
}

// ─── CRM event listener (reply / conversion attribution, opt-out) ─────────────

/** The customer's text for an inbound event: from the hook payload, else the message stored around that moment. */
async function inboundTextOf(event: Extract<CrmEvent, { kind: "interaction" }>): Promise<{ text: string | null; mid: string | null }> {
  const payload = event.payload ?? {};
  const text = typeof payload.text === "string" ? payload.text : null;
  const mid = typeof payload.mid === "string" ? payload.mid : typeof payload.messageId === "string" ? payload.messageId : null;
  if (text !== null) return { text, mid };
  if (!event.conversationId) return { text: null, mid };
  const message = await prisma.conversationMessage.findFirst({
    where: {
      conversationId: event.conversationId,
      author: "CUSTOMER",
      createdAt: { gte: new Date(event.at.getTime() - 2 * 60_000), lte: new Date(event.at.getTime() + 2 * 60_000) },
    },
    orderBy: { createdAt: "desc" },
    select: { text: true, mid: true },
  });
  return { text: message?.text ?? null, mid: mid ?? message?.mid ?? null };
}

export async function onCrmEventForBroadcast(event: CrmEvent): Promise<void> {
  if (event.kind === "interaction") {
    if (event.direction !== "inbound") return;
    const { text, mid } = await inboundTextOf(event);
    await onBroadcastInbound({ contactId: event.contactId, text, mid, at: event.at });
    return;
  }
  if (event.kind === "lead_created" || (event.kind === "stage_changed" && (await isForwardMove(event)))) {
    await onBroadcastDealEvent({ contactId: event.contactId, dealId: event.dealId });
  }
}

/**
 * Only a deal that moved forward is a conversion: into the WON stage, or to
 * a later stage that is not LOST. Moving back, sideways or to LOST is not.
 */
export async function isForwardMove(event: Extract<CrmEvent, { kind: "stage_changed" }>): Promise<boolean> {
  if (event.stageKind === "WON") return true;
  if (event.stageKind === "LOST") return false;
  if (!event.fromStageId) return true;
  const stages = await prisma.crmStage.findMany({ where: { id: { in: [event.fromStageId, event.toStageId] } }, select: { id: true, sort: true } });
  const from = stages.find((s) => s.id === event.fromStageId);
  const to = stages.find((s) => s.id === event.toStageId);
  if (!from || !to) return false;
  return to.sort > from.sort;
}

let listenersRegistered = false;

/** Idempotent; called at module load so every process that emits CRM events attributes broadcasts. */
export function registerBroadcastListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;
  registerCrmListener(onCrmEventForBroadcast);
}

registerBroadcastListeners();
