/**
 * ETAP 5 — the thin façade the /api/developer/crm routes talk to. It
 * re-exports the DB layer (contacts, activity, tags, segments, export, team,
 * assignment, pipeline, timeline, backfill, broadcast), turns the thrown
 * CrmServiceError of the tag / segment / team / assignment modules into the
 * `{ ok, status, error }` result every route answers with, and adds the few
 * compositions the UI needs (contact detail with timeline, notes, custom
 * fields, overview counts, seeded defaults).
 *
 * Every function takes the workspace id first; a row of another workspace
 * reads as 404. Nothing here checks permissions — lib/developer/crm-guard.ts
 * does that per route.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { CrmContact, CrmContactStatus, Prisma } from "@/app/generated/prisma/client";
import { recordActivity } from "./activity";
import { manualAssign, memberOfUser, releaseContact, takeContact } from "./assignment";
import { ensureDefaultPipeline, listPipelines, updateStages, type StageInput } from "./pipeline";
import { getContact, setContactStatus, type ContactWithRelations, type CrmActor } from "./contacts";
import { toServiceFailure } from "./errors";
import { enqueueCrmBackfill, hasCrmQueueBackend, isCrmEnabled } from "./queue";
import { done, fail, type ServiceResult } from "./result";
import { compileSegmentWhere, parseSegmentFilter, segmentFilterSchema, type SegmentFilter } from "./segments";
import { getSegment } from "./segments-service";
import { ensureDefaultTags, tagsOfContact } from "./tags";
import { loadTimeline, type TimelineOptions } from "./timeline";
import { CONTACT_STATUS_LABELS } from "./types";

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { done, fail, firstIssue, type ServiceResult } from "./result";
export { toServiceFailure, isCrmServiceError, CrmServiceError } from "./errors";
export {
  getContact,
  listContacts,
  setContactStatus,
  findContactByConversation,
  buildContactWhere,
  CONTACT_NOT_FOUND,
  type ContactWithRelations,
  type ContactPage,
  type ListContactsOptions,
  type CrmActor,
} from "./contacts";
export { recordActivity, listActivities } from "./activity";
export {
  listTags,
  createTag,
  updateTag,
  deleteTag,
  addTag,
  removeTag,
  tagsOfContact,
  ensureDefaultTags,
  tagInputSchema,
  tagUpdateSchema,
  type TagSummary,
  type ContactTag,
} from "./tags";
export {
  listSegments,
  getSegment,
  createSegment,
  updateSegment,
  deleteSegment,
  previewSegment,
  describeSegment,
  describeSegments,
  loadDescribeNames,
  segmentInputSchema,
  segmentUpdateSchema,
  type SegmentRow,
  type SegmentPreview,
} from "./segments-service";
export { segmentFilterSchema, parseSegmentFilter, compileSegmentWhere, describeFilter, FIELD_SPECS, CUSTOM_FIELD_SPEC, type SegmentFilter } from "./segments";
export { exportContactsCsv, EXPORT_COLUMNS } from "./export";
export { listTeam, setMemberRole, ASSIGNABLE_ROLES, roleInputSchema, type TeamMember } from "./team";
export {
  listRules,
  createRule,
  updateRule,
  deleteRule,
  assignContact,
  takeContact,
  releaseContact,
  manualAssign,
  memberOfUser,
  ruleInputSchema,
  ruleUpdateSchema,
} from "./assignment";
export {
  ensureDefaultPipeline,
  listPipelines,
  updateStages,
  ensureDealForLead,
  moveDeal,
  listDeals,
  validateStages,
  type StageInput,
  type KanbanBoard,
  type KanbanDeal,
  type PipelineSummary,
} from "./pipeline";
export { loadTimeline, TIMELINE_PAGE_LIMIT } from "./timeline";
export { runBackfill, type BackfillCounts } from "./backfill";
export * from "./broadcast";
export { isCrmEnabled };

// ─── Backfill (queued) ────────────────────────────────────────────────────────

export const CRM_DISABLED_MESSAGE = "CRM o'chiq: serverda CRM_ENABLED=1 qo'yilmagan (yoki CRM_DISABLED=1 yoqilgan) — backfill navbatga qo'yilmadi";
export const CRM_QUEUE_MISSING = "Navbat (Redis) sozlanmagan — backfill ishga tushmadi";
export const CRM_QUEUE_DOWN = "Backfill'ni navbatga qo'yib bo'lmadi (Redis) — birozdan keyin qayta urinib ko'ring";

/**
 * The "Backfill" button: hands the import to the CRM worker ("crm-backfill"
 * job → runBackfill, silent, in pages of 500) instead of running it inside
 * the HTTP request. 409 while the CRM is switched off.
 */
export async function requestBackfill(workspaceId: string, requestedBy: string | null): Promise<ServiceResult<{ queued: true }>> {
  if (!isCrmEnabled()) return fail(409, CRM_DISABLED_MESSAGE);
  if (!hasCrmQueueBackend()) return fail(503, CRM_QUEUE_MISSING);
  try {
    await enqueueCrmBackfill({ workspaceId, requestedBy });
  } catch (error) {
    console.error("[CRM] backfill enqueue failed:", error instanceof Error ? error.message : error);
    return fail(503, CRM_QUEUE_DOWN);
  }
  return done({ queued: true });
}

// ─── Thrown-error adapter ─────────────────────────────────────────────────────

/** Runs a DB-layer call that throws CrmServiceError and maps it to a ServiceResult. */
export async function run<T>(fn: () => Promise<T>): Promise<ServiceResult<T>> {
  try {
    return done(await fn());
  } catch (error) {
    return toServiceFailure(error);
  }
}

// ─── Schemas for route bodies ─────────────────────────────────────────────────

export const CONTACT_STATUSES = ["NEW", "ACTIVE", "CUSTOMER", "LOST", "ARCHIVED"] as const;

const CUSTOM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const customValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

export const contactPatchSchema = z
  .object({
    status: z.enum(CONTACT_STATUSES).optional(),
    /** Merged into the existing fields; null removes a key. */
    customFields: z.record(z.string().regex(CUSTOM_KEY, "Maydon nomi harf bilan boshlanib, harf / raqam / _ dan iborat bo'lsin"), customValue).optional(),
    name: z.string().trim().max(120).nullable().optional(),
    email: z.string().trim().email("Email noto'g'ri").max(200).nullable().optional(),
    language: z.string().trim().max(8).nullable().optional(),
    optedOut: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "O'zgartirish uchun hech narsa yuborilmadi" });
export type ContactPatch = z.infer<typeof contactPatchSchema>;

export const noteSchema = z.object({ body: z.string().trim().min(1, "Eslatma bo'sh").max(2000, "Eslatma 2000 belgidan oshmasin") });
export const addTagSchema = z.object({ tagId: z.string().min(1, "Teg tanlanmagan") });
export const assignSchema = z.object({ memberId: z.string().min(1, "A'zo tanlanmagan") });
export const moveDealSchema = z.object({
  stageId: z.string().min(1, "Bosqich tanlanmagan"),
  lostReason: z.string().trim().max(300).nullable().optional(),
});
export const stagesSchema = z.object({
  stages: z
    .array(
      z.object({
        id: z.string().min(1).nullable().optional(),
        name: z.string().trim().min(1, "Bosqich nomi bo'sh").max(40),
        sort: z.number().int().min(0).optional(),
        kind: z.enum(["OPEN", "WON", "LOST"]).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Rang #RRGGBB ko'rinishida bo'lsin").nullable().optional(),
        isEntry: z.boolean().optional(),
      })
    )
    .min(1)
    .max(20),
});
export const segmentPreviewSchema = z.object({ filter: segmentFilterSchema, limit: z.number().int().min(1).max(100).optional() });
export const contactsQuerySchema = z.object({
  q: z.string().max(120).optional(),
  segmentId: z.string().optional(),
  filter: z.string().max(5000).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  orderBy: z.enum(["lastInteractionAt", "createdAt", "updatedAt", "score"]).optional(),
});
export const timelineQuerySchema = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ─── Contacts ─────────────────────────────────────────────────────────────────

/** `?segmentId=` or `?filter=` (JSON DSL) → compiled where for the list / export. */
export async function resolveListWhere(
  workspaceId: string,
  query: { segmentId?: string; filter?: string },
  now = new Date()
): Promise<ServiceResult<Prisma.CrmContactWhereInput | null>> {
  let filter: SegmentFilter | null = null;
  if (query.segmentId) {
    const segment = await run(() => getSegment(workspaceId, query.segmentId!));
    if (!segment.ok) return segment;
    filter = segment.data.filter;
  } else if (query.filter) {
    let raw: unknown;
    try {
      raw = JSON.parse(query.filter);
    } catch {
      return fail(400, "filter JSON emas");
    }
    filter = parseSegmentFilter(raw);
    if (!filter) return fail(400, "Segment filtri noto'g'ri");
  }
  return done(filter ? (compileSegmentWhere(filter, now) as Prisma.CrmContactWhereInput) : null);
}

export interface ContactDetail {
  contact: ContactWithRelations;
  tags: Awaited<ReturnType<typeof tagsOfContact>>;
  timeline: Awaited<ReturnType<typeof loadTimeline>>;
  assignedMember: { id: string; name: string | null; email: string | null } | null;
  accountUsername: string | null;
}

export async function getContactDetail(workspaceId: string, contactId: string, timeline: TimelineOptions = {}): Promise<ServiceResult<ContactDetail>> {
  const contact = await getContact(workspaceId, contactId);
  if (!contact) return fail(404, "Kontakt topilmadi");
  const [tags, page, member, account] = await Promise.all([
    tagsOfContact(contact.id),
    loadTimeline(workspaceId, contact.id, timeline),
    contact.assignedMemberId
      ? prisma.workspaceMember.findFirst({ where: { id: contact.assignedMemberId, workspaceId }, select: { id: true, user: { select: { name: true, email: true } } } })
      : null,
    prisma.instagramAccount.findUnique({ where: { id: contact.instagramAccountId }, select: { username: true } }),
  ]);
  return done({
    contact,
    tags,
    timeline: page,
    assignedMember: member ? { id: member.id, name: member.user?.name ?? null, email: member.user?.email ?? null } : null,
    accountUsername: account?.username ?? null,
  });
}

/** Status / custom fields / name / email / language / manual opt-out on one contact. */
export async function patchContact(workspaceId: string, contactId: string, patch: ContactPatch, actor: CrmActor): Promise<ServiceResult<CrmContact>> {
  const contact = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId } });
  if (!contact) return fail(404, "Kontakt topilmadi");

  if (patch.status && patch.status !== contact.status) {
    const result = await setContactStatus(workspaceId, contact.id, patch.status as CrmContactStatus, actor);
    if (!result.ok) return result;
  }

  const data: Prisma.CrmContactUpdateInput = {};
  const changed: string[] = [];
  if (patch.name !== undefined && patch.name !== contact.name) {
    data.name = patch.name || null;
    changed.push("name");
  }
  if (patch.email !== undefined && patch.email !== contact.email) {
    data.email = patch.email || null;
    changed.push("email");
  }
  if (patch.language !== undefined && patch.language !== contact.language) {
    data.language = patch.language || null;
    changed.push("language");
  }
  if (patch.customFields) {
    const current = (contact.customFields && typeof contact.customFields === "object" && !Array.isArray(contact.customFields)
      ? { ...(contact.customFields as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch.customFields)) {
      if (value === null) delete current[key];
      else current[key] = value;
    }
    data.customFields = current as Prisma.InputJsonObject;
    changed.push(...Object.keys(patch.customFields).map((k) => `custom.${k}`));
  }
  if (patch.optedOut !== undefined && patch.optedOut !== Boolean(contact.optedOutAt)) {
    data.optedOutAt = patch.optedOut ? new Date() : null;
    data.optOutReason = patch.optedOut ? "manual" : null;
    changed.push("optedOut");
  }

  if (changed.length === 0) {
    const fresh = await prisma.crmContact.findUniqueOrThrow({ where: { id: contact.id } });
    return done(fresh);
  }
  const updated = await prisma.crmContact.update({ where: { id: contact.id }, data });
  await recordActivity({
    workspaceId,
    contactId: contact.id,
    type: patch.optedOut && changed.includes("optedOut") ? "OPT_OUT" : "FIELD_CHANGED",
    occurredAt: new Date(),
    actorKind: actor.kind,
    actorMemberId: actor.memberId ?? null,
    title:
      patch.optedOut && changed.includes("optedOut")
        ? "Obunadan chiqarildi (qo'lda)"
        : changed.includes("optedOut")
          ? "Obunaga qaytarildi"
          : `Maydon o'zgardi: ${changed.join(", ")}`,
    payload: { fields: changed },
  });
  return done(updated);
}

export async function addNote(workspaceId: string, contactId: string, body: string, actor: CrmActor): Promise<ServiceResult<{ id: string }>> {
  const contact = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId }, select: { id: true } });
  if (!contact) return fail(404, "Kontakt topilmadi");
  const row = await recordActivity({
    workspaceId,
    contactId: contact.id,
    type: "NOTE",
    occurredAt: new Date(),
    actorKind: actor.kind,
    actorMemberId: actor.memberId ?? null,
    title: "Eslatma",
    body,
  });
  return done({ id: row?.id ?? "" });
}

/** The signed-in user's member row + role, for take / release / manual assign. */
export interface RouteActor extends CrmActor {
  kind: "OPERATOR";
  memberId: string | null;
  userId: string;
  role: string;
}

export async function actorOf(workspaceId: string, userId: string, role: string): Promise<RouteActor> {
  const member = await memberOfUser(workspaceId, userId);
  return { kind: "OPERATOR", memberId: member?.id ?? null, userId, role };
}

export async function assignContactTo(workspaceId: string, contactId: string, memberId: string, actor: { memberId: string | null; userId: string; role: string }) {
  return run(() => manualAssign(workspaceId, actor.role, contactId, memberId, { memberId: actor.memberId, userId: actor.userId }));
}

export async function takeContactAs(workspaceId: string, contactId: string, actor: { memberId: string | null }) {
  if (!actor.memberId) return fail(403, "Siz bu workspace a'zosi emassiz");
  return run(() => takeContact(workspaceId, contactId, actor.memberId!, "manual"));
}

export async function releaseContactAs(workspaceId: string, contactId: string, actor: { memberId: string | null }) {
  if (!actor.memberId) return fail(403, "Siz bu workspace a'zosi emassiz");
  return run(() => releaseContact(workspaceId, contactId, actor.memberId!, "release"));
}

export async function saveStages(workspaceId: string, pipelineId: string, stages: StageInput[]) {
  return updateStages(workspaceId, pipelineId, stages);
}

// ─── Defaults / overview ──────────────────────────────────────────────────────

/** Lazy per-workspace seed on the first CRM visit: default pipeline + tags. */
export async function ensureWorkspaceDefaults(workspaceId: string): Promise<{ pipelineId: string; tagsCreated: number }> {
  const [pipeline, tagsCreated] = await Promise.all([ensureDefaultPipeline(workspaceId), ensureDefaultTags(workspaceId)]);
  return { pipelineId: pipeline.id, tagsCreated };
}

export interface Overview {
  contacts: number;
  byStatus: { status: string; label: string; count: number }[];
  byTemperature: { temperature: string; count: number }[];
  withAiState: number;
  withPhone: number;
  optedOut: number;
  unassigned: number;
  /** Customers who wrote today (local day of the server). */
  inboundToday: number;
  windowOpen: number;
  openDeals: { stageId: string; name: string; color: string | null; kind: string; count: number }[];
  wonDeals: number;
  lostDeals: number;
  broadcasts: { running: number; scheduled: number };
  tags: number;
  segments: number;
  rules: number;
  disabled: boolean;
}

export async function getOverview(workspaceId: string, now = new Date()): Promise<Overview> {
  const base: Prisma.CrmContactWhereInput = { workspaceId, mergedIntoId: null };
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const windowEdge = new Date(now.getTime() - (24 * 3600_000 - 5 * 60_000));

  const count = (where: Prisma.CrmContactWhereInput) => prisma.crmContact.count({ where: { ...base, ...where } });
  const statuses = ["NEW", "ACTIVE", "CUSTOMER", "LOST", "ARCHIVED"] as const;
  const temperatures = ["COLD", "WARM", "HOT", "CUSTOMER", "LOST"] as const;

  const pipeline = await listPipelines(workspaceId);
  const [contacts, byStatus, byTemperature, withAiState, withPhone, optedOut, unassigned, inboundToday, windowOpen, won, lost, running, scheduled, tags, segments, rules] =
    await Promise.all([
      count({}),
      Promise.all(statuses.map(async (status) => ({ status, label: CONTACT_STATUS_LABELS[status], count: await count({ status }) }))),
      Promise.all(temperatures.map(async (temperature) => ({ temperature, count: await count({ hasAiState: true, temperature }) }))),
      count({ hasAiState: true }),
      count({ phoneE164: { not: null } }),
      count({ optedOutAt: { not: null } }),
      count({ assignedMemberId: null, status: { notIn: ["ARCHIVED", "LOST"] } }),
      count({ lastInboundAt: { gte: startOfDay } }),
      count({ lastInboundAt: { gt: windowEdge } }),
      prisma.crmDeal.count({ where: { workspaceId, wonAt: { not: null } } }),
      prisma.crmDeal.count({ where: { workspaceId, lostAt: { not: null } } }),
      prisma.crmBroadcast.count({ where: { workspaceId, status: "RUNNING" } }),
      prisma.crmBroadcast.count({ where: { workspaceId, status: "SCHEDULED" } }),
      prisma.crmTag.count({ where: { workspaceId } }),
      prisma.crmSegment.count({ where: { workspaceId } }),
      prisma.crmAssignmentRule.count({ where: { workspaceId, active: true } }),
    ]);

  const openDeals = pipeline
    .flatMap((p) => p.stages)
    .filter((stage) => stage.kind === "OPEN")
    .map((stage) => ({ stageId: stage.id, name: stage.name, color: stage.color, kind: stage.kind, count: stage.dealCount }));

  return {
    contacts,
    byStatus,
    byTemperature,
    withAiState,
    withPhone,
    optedOut,
    unassigned,
    inboundToday,
    windowOpen,
    openDeals,
    wonDeals: won,
    lostDeals: lost,
    broadcasts: { running, scheduled },
    tags,
    segments,
    rules,
    disabled: !isCrmEnabled(),
  };
}
