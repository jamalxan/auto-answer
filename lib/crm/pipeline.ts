/**
 * ETAP 5.2 — pipeline (TZ 30, owner decision 1).
 *
 * One default pipeline per workspace, seeded lazily from DEFAULT_STAGES in
 * Uzbek. Every production Lead gets one CrmDeal in the entry stage ("Yangi
 * lead"); the Telegram "Bog'lanildi" button moves it to "Bog'lanildi"; a
 * drag in the Kanban moves it anywhere. WON / LOST close the deal, set the
 * contact's status and write JavobAI's temperature back (CUSTOMER / LOST) on
 * the AiConversationState row — the same column setConversationTemperature
 * in lib/javobai/service.ts writes, without pulling that module in.
 */

import type { CrmDeal, CrmPipeline, CrmStage, CrmStageKind, Lead, Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { temperatureFor } from "@/lib/javobai/scoring";
import { loadScoringConfig } from "@/lib/javobai/state";
import { isUniqueViolation, recordActivity } from "./activity";
import { upsertContactFromParts, type CrmActor, type CrmServiceResult } from "./contacts";
import { DEFAULT_PIPELINE_NAME, DEFAULT_STAGES, STAGE_KIND_TEMPERATURE } from "./defaults";
import { emitCrmEvent } from "./hooks";
import type { CrmContactSource } from "./types";

export type { CrmActor, CrmServiceResult } from "./contacts";

export const PIPELINE_NOT_FOUND = "Voronka topilmadi";
export const STAGE_NOT_FOUND = "Bosqich topilmadi";
export const DEAL_NOT_FOUND = "Bitim topilmadi";
export const STAGE_HAS_DEALS = "Bosqichda hali bitimlar bor — avval ularni boshqa bosqichga ko'chiring, keyin o'chiring";
/** Cards per Kanban column; the column header shows the full count. */
export const DEALS_PER_STAGE = 100;
export const NO_ENTRY_STAGE = "Voronkada kirish bosqichi yo'q — bosqichlarni tahrirlab bittasini \"kirish\" deb belgilang";

export type PipelineWithStages = CrmPipeline & { stages: CrmStage[] };

const fail = (status: number, error: string) => ({ ok: false as const, status, error });
const done = <T>(data: T) => ({ ok: true as const, data });

const stagesOrdered = { stages: { orderBy: { sort: "asc" as const } } } satisfies Prisma.CrmPipelineInclude;

// ─── Pipelines & stages ───────────────────────────────────────────────────────

/**
 * The workspace's default pipeline with its stages, created on first use.
 * Idempotent: a race on the unique (workspaceId, name) re-reads the winner.
 */
export async function ensureDefaultPipeline(workspaceId: string): Promise<PipelineWithStages> {
  const existing = await prisma.crmPipeline.findFirst({
    where: { workspaceId, isDefault: true },
    include: stagesOrdered,
  });
  if (existing) return existing;

  let pipeline: CrmPipeline;
  try {
    pipeline = await prisma.crmPipeline.create({ data: { workspaceId, name: DEFAULT_PIPELINE_NAME, isDefault: true } });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await prisma.crmPipeline.findFirst({ where: { workspaceId, name: DEFAULT_PIPELINE_NAME }, include: stagesOrdered });
    if (!raced) throw error;
    if (!raced.isDefault) await prisma.crmPipeline.update({ where: { id: raced.id }, data: { isDefault: true } });
    if (raced.stages.length > 0) return raced;
    pipeline = raced;
  }
  for (const stage of DEFAULT_STAGES) {
    try {
      await prisma.crmStage.create({
        data: { pipelineId: pipeline.id, name: stage.name, sort: stage.sort, kind: stage.kind, color: stage.color, isEntry: stage.isEntry },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error; // the other worker is seeding too
    }
  }
  return prisma.crmPipeline.findUniqueOrThrow({ where: { id: pipeline.id }, include: stagesOrdered });
}

export type PipelineSummary = CrmPipeline & { stages: Array<CrmStage & { dealCount: number }> };

/** Every pipeline of the workspace (the default seeded if missing) with deal counts per stage. */
export async function listPipelines(workspaceId: string): Promise<PipelineSummary[]> {
  await ensureDefaultPipeline(workspaceId);
  const rows = await prisma.crmPipeline.findMany({
    where: { workspaceId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: { stages: { orderBy: { sort: "asc" }, include: { _count: { select: { deals: true } } } } },
  });
  return rows.map((p) => ({
    ...p,
    stages: p.stages.map(({ _count, ...stage }) => ({ ...stage, dealCount: _count.deals })),
  }));
}

export interface StageInput {
  /** Existing stage id; omitted = new stage. */
  id?: string | null;
  name: string;
  sort?: number;
  kind?: CrmStageKind;
  color?: string | null;
  isEntry?: boolean;
}

export function validateStages(stages: StageInput[]): string | null {
  if (stages.length === 0) return "Kamida bitta bosqich kerak";
  if (stages.length > 20) return "Bosqichlar soni 20 tadan oshmasligi kerak";
  const names = stages.map((s) => s.name.trim());
  if (names.some((n) => !n)) return "Bosqich nomi bo'sh bo'lmasligi kerak";
  if (names.some((n) => n.length > 40)) return "Bosqich nomi 40 belgidan oshmasligi kerak";
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return "Bosqich nomlari takrorlanmasligi kerak";
  const entries = stages.filter((s) => s.isEntry);
  if (entries.length !== 1) return "Aynan bitta kirish bosqichi (yangi lead tushadigan) bo'lishi kerak";
  if ((entries[0].kind ?? "OPEN") !== "OPEN") return "Kirish bosqichi \"Jarayonda\" turida bo'lishi kerak";
  if (stages.filter((s) => s.kind === "WON").length > 1) return "Faqat bitta \"Yutildi\" turidagi bosqich bo'lishi mumkin";
  if (stages.filter((s) => s.kind === "LOST").length > 1) return "Faqat bitta \"Yo'qotildi\" turidagi bosqich bo'lishi mumkin";
  const ids = stages.map((s) => s.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) return "Bir bosqich ikki marta yuborilgan";
  return null;
}

/** Postgres foreign-key violation (P2003), duck-typed like isUniqueViolation. */
function isForeignKeyViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "P2003");
}

/**
 * Replace the stage list of a pipeline: rename, reorder, add, change kind /
 * colour / entry flag, delete. A stage that still holds deals cannot be
 * deleted (422 with the count) — move them first. A deal that lands in the
 * stage between the check and the delete trips the RESTRICT foreign key:
 * also 422, nothing changed. ON_STAGE assignment rules of a deleted stage are
 * deactivated and lose their stage (CrmAssignmentRule.stageId has no foreign
 * key), so they never point at a stage that no longer exists.
 */
export async function updateStages(
  workspaceId: string,
  pipelineId: string,
  stages: StageInput[]
): Promise<CrmServiceResult<PipelineWithStages>> {
  const pipeline = await prisma.crmPipeline.findFirst({ where: { id: pipelineId, workspaceId }, include: stagesOrdered });
  if (!pipeline) return fail(404, PIPELINE_NOT_FOUND);
  const problem = validateStages(stages);
  if (problem) return fail(422, problem);

  const byId = new Map(pipeline.stages.map((s) => [s.id, s]));
  for (const input of stages) {
    if (input.id && !byId.has(input.id)) return fail(404, STAGE_NOT_FOUND);
  }
  const keptIds = new Set(stages.map((s) => s.id).filter((id): id is string => Boolean(id)));
  const removed = pipeline.stages.filter((s) => !keptIds.has(s.id));
  for (const stage of removed) {
    const deals = await prisma.crmDeal.count({ where: { stageId: stage.id } });
    if (deals > 0) {
      return fail(422, `"${stage.name}" bosqichida ${deals} ta bitim bor — avval ularni boshqa bosqichga ko'chiring`);
    }
  }

  try {
    await replaceStages(pipeline, stages, removed);
  } catch (error) {
    if (isForeignKeyViolation(error)) return fail(422, STAGE_HAS_DEALS);
    throw error;
  }
  return done(await prisma.crmPipeline.findUniqueOrThrow({ where: { id: pipeline.id }, include: stagesOrdered }));
}

async function replaceStages(pipeline: PipelineWithStages, stages: StageInput[], removed: CrmStage[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const stage of removed) await tx.crmStage.delete({ where: { id: stage.id } });
    if (removed.length > 0) {
      await tx.crmAssignmentRule.updateMany({
        where: { workspaceId: pipeline.workspaceId, stageId: { in: removed.map((s) => s.id) } },
        data: { active: false, stageId: null },
      });
    }
    // Renames may swap names: park the kept stages on temporary names first.
    for (const input of stages) {
      if (input.id) await tx.crmStage.update({ where: { id: input.id }, data: { name: `~tmp:${input.id}` } });
    }
    for (const [index, input] of stages.entries()) {
      const data = {
        name: input.name.trim(),
        sort: input.sort ?? index,
        kind: input.kind ?? "OPEN",
        color: input.color ?? null,
        isEntry: Boolean(input.isEntry),
      };
      if (input.id) await tx.crmStage.update({ where: { id: input.id }, data });
      else await tx.crmStage.create({ data: { pipelineId: pipeline.id, ...data } });
    }
  });
}

export function entryStage(pipeline: PipelineWithStages): CrmStage | null {
  return pipeline.stages.find((s) => s.isEntry) ?? pipeline.stages.find((s) => s.kind === "OPEN") ?? null;
}

/** "Bog'lanildi": the stage the Telegram button moves a deal to. */
export function contactedStage(pipeline: PipelineWithStages): CrmStage | null {
  const byName = DEFAULT_STAGES.find((s) => s.key === "CONTACTED")!.name.toLowerCase();
  const named = pipeline.stages.find((s) => s.name.trim().toLowerCase() === byName);
  if (named) return named;
  const entry = entryStage(pipeline);
  if (!entry) return null;
  return pipeline.stages.find((s) => s.kind === "OPEN" && s.sort > entry.sort) ?? null;
}

// ─── Deals ────────────────────────────────────────────────────────────────────

function leadSource(lead: Pick<Lead, "source">): CrmContactSource {
  return lead.source === "CAMPAIGN" ? "COMMENT" : "DM";
}

export function dealTitleFor(lead: Pick<Lead, "name" | "igUsername" | "phoneE164" | "igUserId" | "productInterest">): string {
  const who = lead.name?.trim() || (lead.igUsername ? `@${lead.igUsername}` : null) || lead.phoneE164 || lead.igUserId;
  const product = lead.productInterest?.trim();
  return (product ? `${who} — ${product}` : who).slice(0, 120);
}

/**
 * The deal of a production Lead, created in the entry stage of the default
 * pipeline on first sight (idempotent on leadId). Links the contact through
 * the lead's conversation / igUserId, sets the contact ACTIVE, writes the
 * DEAL_CREATED + LEAD_CREATED activities and emits "lead_created". Synthetic
 * test leads get no deal.
 */
export interface SilentOption {
  /**
   * Backfill / reconciler over history: write the rows, emit no listener
   * events (no ON_LEAD / ON_STAGE assignment, Telegram alert or broadcast
   * attribution for something that happened long ago).
   */
  silent?: boolean;
}

export async function ensureDealForLead(leadId: string, options: SilentOption = {}): Promise<CrmDeal | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.isTest) return null;
  const existing = await prisma.crmDeal.findUnique({ where: { leadId: lead.id } });
  if (existing) return existing;

  const contact = await upsertContactFromParts(
    {
      workspaceId: lead.workspaceId,
      instagramAccountId: lead.instagramAccountId,
      igUserId: lead.igUserId,
      username: lead.igUsername,
      name: lead.name,
      phoneE164: lead.phoneE164,
      language: lead.language,
      source: leadSource(lead),
      conversationId: lead.conversationId,
    },
    { silent: true }
  );
  const pipeline = await ensureDefaultPipeline(lead.workspaceId);
  const entry = entryStage(pipeline);
  if (!entry) throw new Error(NO_ENTRY_STAGE);

  let deal: CrmDeal;
  try {
    deal = await prisma.crmDeal.create({
      data: {
        workspaceId: lead.workspaceId,
        contactId: contact.id,
        pipelineId: pipeline.id,
        stageId: entry.id,
        leadId: lead.id,
        title: dealTitleFor(lead),
        stageEnteredAt: lead.createdAt,
        assignedMemberId: contact.assignedMemberId,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return prisma.crmDeal.findUniqueOrThrow({ where: { leadId: lead.id } });
  }

  if (contact.status === "NEW") {
    await prisma.crmContact.update({ where: { id: contact.id }, data: { status: "ACTIVE" } });
  }
  await recordActivity({
    workspaceId: lead.workspaceId,
    contactId: contact.id,
    dealId: deal.id,
    type: "LEAD_CREATED",
    occurredAt: lead.createdAt,
    actorKind: "SYSTEM",
    title: lead.isRepeat ? "Takroriy lead yaratildi" : "Lead yaratildi",
    body: lead.summary,
    payload: { leadId: lead.id, source: lead.source, campaignName: lead.campaignName, productInterest: lead.productInterest, flag: lead.flag },
    sourceTable: "Lead",
    sourceId: lead.id,
  });
  await recordActivity({
    workspaceId: lead.workspaceId,
    contactId: contact.id,
    dealId: deal.id,
    type: "DEAL_CREATED",
    occurredAt: lead.createdAt,
    actorKind: "SYSTEM",
    title: `Bitim "${entry.name}" bosqichida ochildi`,
    payload: { leadId: lead.id, stageId: entry.id, stageName: entry.name },
    sourceTable: "Lead",
    sourceId: lead.id,
  });
  if (!options.silent) {
    const fresh = await prisma.crmContact.findUniqueOrThrow({ where: { id: contact.id } });
    await emitCrmEvent({
      kind: "lead_created",
      workspaceId: lead.workspaceId,
      contactId: contact.id,
      contact: fresh,
      leadId: lead.id,
      dealId: deal.id,
      productInterest: lead.productInterest,
    });
  }
  if (lead.contactedAt) await markLeadContacted(lead.id, { userId: lead.contactedByUserId, silent: options.silent });
  return deal;
}

async function memberIdFor(workspaceId: string, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true },
  });
  return member?.id ?? null;
}

async function writeTemperature(
  contactId: string,
  conversationId: string | null,
  kind: CrmStageKind,
  workspaceId: string,
  instagramAccountId: string
): Promise<void> {
  if (!conversationId) return;
  const state = await prisma.aiConversationState.findUnique({ where: { conversationId } });
  if (!state) return; // no JavobAI state: the contact shows "—", nothing to write back
  const closed = STAGE_KIND_TEMPERATURE[kind];
  let temperature = closed ?? null;
  if (!temperature) {
    // Back to an open stage: the score decides again.
    const config = await loadScoringConfig(workspaceId, instagramAccountId);
    temperature = temperatureFor(state.score, config.thresholds);
  }
  if (temperature === state.temperature) return;
  await prisma.aiConversationState.update({ where: { id: state.id }, data: { temperature } });
  await prisma.crmContact.update({ where: { id: contactId }, data: { temperature, hasAiState: true } });
}

export interface MoveDealOptions extends SilentOption {
  /** LOST only: why. */
  lostReason?: string | null;
  /** Idempotency key for event-driven moves (sourceTable / sourceId of the activity). */
  source?: { table: string; id: string } | null;
}

/**
 * Move a deal to another stage of its pipeline. STAGE_CHANGED activity; WON
 * closes it (wonAt, contact CUSTOMER, JavobAI CUSTOMER), LOST likewise
 * (lostAt / lostReason, LOST); moving back to an open stage clears both and
 * lets the score decide the temperature again. Same stage = no-op.
 */
export async function moveDeal(
  workspaceId: string,
  dealId: string,
  stageId: string,
  actor: CrmActor,
  options: MoveDealOptions = {}
): Promise<CrmServiceResult<CrmDeal>> {
  const deal = await prisma.crmDeal.findFirst({ where: { id: dealId, workspaceId }, include: { stage: true, contact: true } });
  if (!deal) return fail(404, DEAL_NOT_FOUND);
  const stage = await prisma.crmStage.findFirst({ where: { id: stageId, pipelineId: deal.pipelineId } });
  if (!stage) return fail(404, STAGE_NOT_FOUND);
  if (stage.id === deal.stageId) return done(deal);

  const now = new Date();
  const updated = await prisma.crmDeal.update({
    where: { id: deal.id },
    data: {
      stageId: stage.id,
      stageEnteredAt: now,
      wonAt: stage.kind === "WON" ? now : null,
      lostAt: stage.kind === "LOST" ? now : null,
      lostReason: stage.kind === "LOST" ? (options.lostReason?.trim().slice(0, 300) || null) : null,
    },
  });

  // Phase 7: a sale goes back to Meta (Conversions API) when an ad account runs this IG account.
  if (stage.kind === "WON" && !deal.wonAt) {
    await import("@/lib/ads/service")
      .then(({ queueSaleEvent }) => queueSaleEvent(workspaceId, deal.id))
      .catch((error) => console.warn("[crm] CAPI queue failed:", error instanceof Error ? error.message : error));
  }

  const status = stage.kind === "WON" ? "CUSTOMER" : stage.kind === "LOST" ? "LOST" : "ACTIVE";
  if (deal.contact.status !== status && deal.contact.status !== "ARCHIVED") {
    await prisma.crmContact.update({ where: { id: deal.contactId }, data: { status } });
  }
  await writeTemperature(deal.contactId, deal.contact.conversationId, stage.kind, workspaceId, deal.contact.instagramAccountId);

  await recordActivity({
    workspaceId,
    contactId: deal.contactId,
    dealId: deal.id,
    type: "STAGE_CHANGED",
    occurredAt: now,
    actorKind: actor.kind,
    actorMemberId: actor.memberId ?? null,
    title: `Bosqich: ${deal.stage.name} → ${stage.name}`,
    body: stage.kind === "LOST" ? updated.lostReason : null,
    payload: { fromStageId: deal.stageId, fromStage: deal.stage.name, toStageId: stage.id, toStage: stage.name, kind: stage.kind },
    sourceTable: options.source?.table ?? null,
    sourceId: options.source?.id ?? null,
  });
  if (options.silent) return done(updated);
  const contact = await prisma.crmContact.findUniqueOrThrow({ where: { id: deal.contactId } });
  await emitCrmEvent({
    kind: "stage_changed",
    workspaceId,
    contactId: deal.contactId,
    contact,
    dealId: deal.id,
    fromStageId: deal.stageId,
    toStageId: stage.id,
    stageKind: stage.kind,
    actor,
  });
  return done(updated);
}

/**
 * The Telegram "Bog'lanildi" button (Lead.contactedAt): a deal still in the
 * entry stage moves to "Bog'lanildi". Idempotent — a deal already further
 * along is left where it is. Null when the lead has no deal.
 */
export async function markLeadContacted(leadId: string, options: { userId?: string | null } & SilentOption = {}): Promise<CrmDeal | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return null;
  const deal = (await prisma.crmDeal.findUnique({ where: { leadId: lead.id } })) ?? (await ensureDealForLead(lead.id, { silent: options.silent }));
  if (!deal) return null;
  const stage = await prisma.crmStage.findUnique({ where: { id: deal.stageId } });
  if (!stage?.isEntry) return deal;
  const pipeline = await prisma.crmPipeline.findUniqueOrThrow({ where: { id: deal.pipelineId }, include: stagesOrdered });
  const target = contactedStage(pipeline);
  if (!target || target.id === stage.id) return deal;

  const memberId = await memberIdFor(lead.workspaceId, options.userId ?? lead.contactedByUserId);
  const moved = await moveDeal(
    lead.workspaceId,
    deal.id,
    target.id,
    { kind: memberId ? "OPERATOR" : "SYSTEM", memberId },
    { source: { table: "Lead", id: `${lead.id}:contacted` }, silent: options.silent }
  );
  if (!moved.ok) return deal;
  if (options.silent) return moved.data;
  const contact = await prisma.crmContact.findUniqueOrThrow({ where: { id: deal.contactId } });
  await emitCrmEvent({ kind: "lead_contacted", workspaceId: lead.workspaceId, contactId: deal.contactId, contact, leadId: lead.id, dealId: deal.id, memberId });
  return moved.data;
}

// ─── Kanban ───────────────────────────────────────────────────────────────────

const dealInclude = {
  contact: {
    select: {
      id: true,
      username: true,
      name: true,
      phoneE164: true,
      score: true,
      temperature: true,
      hasAiState: true,
      assignedMemberId: true,
      lastInteractionAt: true,
    },
  },
} satisfies Prisma.CrmDealInclude;

export type KanbanDeal = Prisma.CrmDealGetPayload<{ include: typeof dealInclude }>;

export interface KanbanColumn {
  stage: CrmStage;
  /** Newest DEALS_PER_STAGE by stage entry. */
  deals: KanbanDeal[];
  /** Every deal in the stage (may exceed deals.length). */
  count: number;
}

export interface KanbanBoard {
  pipeline: CrmPipeline;
  columns: KanbanColumn[];
  total: number;
}

/** Deals grouped by stage, newest stage entry first, at most DEALS_PER_STAGE per column plus the real count (the Kanban's data). */
export async function listDeals(workspaceId: string, pipelineId?: string | null): Promise<CrmServiceResult<KanbanBoard>> {
  const pipeline = pipelineId
    ? await prisma.crmPipeline.findFirst({ where: { id: pipelineId, workspaceId }, include: stagesOrdered })
    : await ensureDefaultPipeline(workspaceId);
  if (!pipeline) return fail(404, PIPELINE_NOT_FOUND);
  const { stages, ...rest } = pipeline;
  const columns = await Promise.all(
    stages.map(async (stage) => {
      const where = { workspaceId, pipelineId: pipeline.id, stageId: stage.id };
      const [deals, count] = await Promise.all([
        prisma.crmDeal.findMany({ where, orderBy: [{ stageEnteredAt: "desc" }, { id: "desc" }], take: DEALS_PER_STAGE, include: dealInclude }),
        prisma.crmDeal.count({ where }),
      ]);
      return { stage, deals, count };
    })
  );
  return done({
    pipeline: rest,
    columns,
    total: columns.reduce((sum, column) => sum + column.count, 0),
  });
}
