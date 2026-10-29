/**
 * ETAP 6/7 — the Flow DB layer the /api/flows routes talk to:
 * flows, draft versions (hash, audit, policy), test, approval, publish
 * gating, versions + diff, templates and the editor's `meta`.
 *
 * Rules (decisions in docs/developer/etap-6-7-flow-builder.md):
 *  - every query is scoped by workspaceId; a flow / version / account of
 *    another workspace reads as 404;
 *  - a draft is saved IN PLACE while it is unpublished; after a publish the
 *    next save opens a new version row (v(n+1)). A changed hash resets
 *    testedAt / approvedAt (the audit / policy are recomputed every save);
 *  - approval before publish is required ONLY for AI-generated versions
 *    (and they need a passing test first); a BLOCKED policy or any audit
 *    error stops every publish; WARNING needs an acknowledgement;
 *  - the engine side (publish / sandbox / runs) lives in lib/flows/{publish,
 *    sandbox,runs}.ts and is only called through its public functions.
 *
 * Functions throw FlowServiceError; `run()` maps it to a ServiceResult.
 */

import { z } from "zod";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { done, firstIssue, type ServiceResult } from "@/lib/crm/result";
import { createTag } from "@/lib/crm/tags";
import { BUILT_IN_INTENTS } from "@/lib/triggers/keywords";
import { generateFlowFromPrompt } from "./ai-builder";
import { type AuditResult, auditGraph } from "./audit";
import { diffGraphs, type GraphDiff, hashGraph } from "./canonical";
import { FIELD_SPECS, FLOW_OPERATORS } from "./conditions";
import { auditContextFrom, loadFlowContext } from "./context";
import { badRequest, FlowServiceError, notFound, toFlowFailure, unprocessable } from "./errors";
import { evaluatePolicy, type PolicyResult } from "./policy";
import { archiveFlow, publishFlowVersion, unpublishFlow } from "./publish";
import { runFlowSandbox } from "./sandbox";
import {
  FLOW_LIMITS,
  FLOW_TRIGGER_TYPES,
  type FlowGraph,
  flowGraphDraftSchema,
  flowGraphSchema,
  type FlowTriggerType,
  NODE_LABELS,
  TRIGGER_TYPE_LABELS,
} from "./schema";
import { FLOW_STARTER_TEMPLATES, findStarterTemplate } from "./templates";
import { VARIABLE_SPECS } from "./variables";

export { FlowServiceError, isFlowServiceError } from "./errors";
export type { ServiceResult } from "@/lib/crm/result";

/** Runs a DB-layer call that throws FlowServiceError and maps it to a ServiceResult. */
export async function run<T>(fn: () => Promise<T>): Promise<ServiceResult<T>> {
  try {
    return done(await fn());
  } catch (error) {
    return toFlowFailure(error);
  }
}

export const FLOW_NOT_FOUND = "Oqim topilmadi";
export const VERSION_NOT_FOUND = "Versiya topilmadi";
export const ACCOUNT_NOT_FOUND = "Instagram akkaunt topilmadi";
export const TEMPLATE_NOT_FOUND = "Shablon topilmadi";
export const FLOW_ARCHIVED = "Arxivdagi oqimni tahrirlab bo'lmaydi";

export function isFlowsEnabled(): boolean {
  const flag = (process.env.FLOWS_DISABLED ?? "").trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}

// ─── Row shapes ───────────────────────────────────────────────────────────────

type FlowRow = {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  name: string;
  mode: "SIMPLE" | "ADVANCED";
  status: "DRAFT" | "REVIEW" | "PUBLISHED" | "ARCHIVED";
  triggerType: string;
  draftVersionId: string | null;
  publishedVersionId: string | null;
  proxyCampaignId: string | null;
  createdByUserId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type VersionRow = {
  id: string;
  flowId: string;
  version: number;
  schemaVersion: number;
  graph: unknown;
  hash: string;
  source: "MANUAL" | "AI" | "TEMPLATE" | "IMPORT";
  prompt: string | null;
  changeNote: string | null;
  auditResult: unknown;
  policyResult: unknown;
  testedAt: Date | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  retiredAt: Date | null;
  createdAt: Date;
};

interface StoredAudit extends AuditResult {
  hash: string;
  at: string;
}
interface StoredPolicy extends PolicyResult {
  hash: string;
  at: string;
}

export interface VersionSummary {
  id: string;
  flowId: string;
  version: number;
  source: VersionRow["source"];
  hash: string;
  changeNote: string | null;
  state: "DRAFT" | "PUBLISHED" | "RETIRED" | "OLD";
  testedAt: Date | null;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  publishedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
  auditCounts: { errors: number; warnings: number; suggestions: number } | null;
  policyVerdict: PolicyResult["verdict"] | null;
}

const ACTIVE_RUN_STATUSES = ["ACTIVE", "WAITING_TAP", "WAITING_INBOUND", "WAITING_DELAY"] as const;
const DAY_MS = 86_400_000;

// ─── Loaders ──────────────────────────────────────────────────────────────────

async function loadFlow(workspaceId: string, flowId: string): Promise<FlowRow> {
  const flow = await prisma.flow.findFirst({ where: { id: flowId, workspaceId } });
  if (!flow) throw notFound(FLOW_NOT_FOUND);
  return flow as unknown as FlowRow;
}

async function loadVersion(workspaceId: string, flowId: string, versionId: string): Promise<{ flow: FlowRow; version: VersionRow }> {
  const flow = await loadFlow(workspaceId, flowId);
  const version = await prisma.flowVersion.findFirst({ where: { id: versionId, flowId: flow.id } });
  if (!version) throw notFound(VERSION_NOT_FOUND);
  return { flow, version: version as unknown as VersionRow };
}

async function ownedAccount(workspaceId: string, accountId: string) {
  const account = await prisma.instagramAccount.findFirst({ where: { id: accountId, workspaceId }, select: { id: true, username: true } });
  if (!account) throw notFound(ACCOUNT_NOT_FOUND);
  return account;
}

function graphOf(version: VersionRow): FlowGraph {
  const parsed = flowGraphDraftSchema.safeParse(version.graph);
  if (!parsed.success) throw unprocessable("Saqlangan graf buzilgan — yangi qoralama sifatida qayta saqlang");
  return parsed.data;
}

function triggerTypeOf(graph: FlowGraph): FlowTriggerType | null {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  return trigger && trigger.type === "trigger" ? trigger.triggerType : null;
}

function asStoredAudit(value: unknown): StoredAudit | null {
  const v = value as StoredAudit | null;
  return v && Array.isArray(v.errors) ? v : null;
}
function asStoredPolicy(value: unknown): StoredPolicy | null {
  const v = value as StoredPolicy | null;
  return v && typeof v.verdict === "string" ? v : null;
}

function summarize(flow: FlowRow, version: VersionRow): VersionSummary {
  const audit = asStoredAudit(version.auditResult);
  const policy = asStoredPolicy(version.policyResult);
  const state: VersionSummary["state"] =
    flow.publishedVersionId === version.id
      ? "PUBLISHED"
      : flow.draftVersionId === version.id && !version.publishedAt
        ? "DRAFT"
        : version.retiredAt
          ? "RETIRED"
          : "OLD";
  return {
    id: version.id,
    flowId: version.flowId,
    version: version.version,
    source: version.source,
    hash: version.hash,
    changeNote: version.changeNote ?? null,
    state,
    testedAt: version.testedAt ?? null,
    approvedAt: version.approvedAt ?? null,
    approvedByUserId: version.approvedByUserId ?? null,
    publishedAt: version.publishedAt ?? null,
    retiredAt: version.retiredAt ?? null,
    createdAt: version.createdAt,
    auditCounts: audit ? { errors: audit.errors.length, warnings: audit.warnings.length, suggestions: audit.suggestions.length } : null,
    policyVerdict: policy?.verdict ?? null,
  };
}

// ─── Audit + policy ───────────────────────────────────────────────────────────

export interface EvaluationResult {
  audit: StoredAudit;
  policy: StoredPolicy;
  hash: string;
  /** Structural problems that stop a publish even when the audit is clean (flowGraphSchema). */
  structural: string[];
  publishable: boolean;
}

async function evaluate(flow: FlowRow, graph: FlowGraph): Promise<EvaluationResult> {
  const ctx = await loadFlowContext(flow.workspaceId, flow.instagramAccountId);
  const trigger = triggerTypeOf(graph) ?? (flow.triggerType as FlowTriggerType);
  const auditCtx = auditContextFrom(ctx, trigger);
  const at = new Date().toISOString();
  const hash = hashGraph(graph);
  const audit: StoredAudit = { ...auditGraph(graph, auditCtx), hash, at };
  const policy: StoredPolicy = { ...evaluatePolicy(graph, auditCtx), hash, at };
  const structure = flowGraphSchema.safeParse(graph);
  const structural = structure.success ? [] : structure.error.issues.map((i) => i.message).slice(0, 10);
  return { audit, policy, hash, structural, publishable: audit.errors.length === 0 && policy.verdict !== "BLOCKED" && structural.length === 0 };
}

async function storeEvaluation(version: VersionRow, evaluation: EvaluationResult) {
  await prisma.flowVersion.update({
    where: { id: version.id },
    data: { auditResult: evaluation.audit as unknown as Prisma.InputJsonValue, policyResult: evaluation.policy as unknown as Prisma.InputJsonValue },
  });
}

/** Audit + policy of a version (default: the draft); stored on the version. */
export async function runAudit(workspaceId: string, flowId: string, versionId?: string) {
  const flow = await loadFlow(workspaceId, flowId);
  const id = versionId ?? flow.draftVersionId ?? flow.publishedVersionId;
  if (!id) throw notFound(VERSION_NOT_FOUND);
  const { version } = await loadVersion(workspaceId, flowId, id);
  const evaluation = await evaluate(flow, graphOf(version));
  await storeEvaluation(version, evaluation);
  return { versionId: version.id, ...evaluation };
}

// ─── Create / list / get ──────────────────────────────────────────────────────

const flowModeSchema = z.enum(["SIMPLE", "ADVANCED"]);

export const createFlowSchema = z
  .object({
    name: z.string().trim().min(1, "Oqim nomi kiritilmagan").max(120, "Nom 120 belgidan oshmasin").optional(),
    instagramAccountId: z.string().min(1, "Instagram akkaunt tanlanmagan"),
    mode: flowModeSchema.default("SIMPLE"),
    fromTemplateKey: z.string().min(1).max(200).optional(),
    graph: z.unknown().optional(),
    prompt: z.string().trim().min(1).max(2000).optional(),
    /** Blank flow: the trigger type of the starting graph. */
    triggerType: z.enum(FLOW_TRIGGER_TYPES).optional(),
    changeNote: z.string().max(200).optional(),
  })
  .refine((v) => !(v.fromTemplateKey && (v.graph !== undefined || v.prompt)), {
    message: "Shablon bilan graf yoki AI so'rovni birga bermang",
  });
export type CreateFlowInput = z.infer<typeof createFlowSchema>;

/** The starting graph of a "Bo'sh" flow: trigger → one message → end. */
export function blankGraph(triggerType: FlowTriggerType = "DIRECT_MESSAGE"): FlowGraph {
  const comment = triggerType === "COMMENT" || triggerType === "LIVE_COMMENT";
  return flowGraphDraftSchema.parse({
    v: 1,
    nodes: [
      { id: "trigger", type: "trigger", triggerType, matchingMode: "EVERY" },
      comment
        ? { id: "m1", type: "message", text: "Salom! Narx va tafsilotlarni yuboraymi?", button: { id: "open", label: "Ha, yuboring" } }
        : { id: "m1", type: "message", text: "Salom! Yozganingiz uchun rahmat." },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "trigger", to: "m1", handle: "next" },
      comment ? { from: "m1", to: "end", handle: "tap" } : { from: "m1", to: "end", handle: "next" },
    ],
    variables: [],
  });
}

async function ensureTemplateTags(workspaceId: string, slugs: string[]) {
  for (const slug of slugs) {
    try {
      await createTag(workspaceId, { name: slug });
    } catch {
      // exists already (422) or the slug is odd — the auditor reports a missing tag.
    }
  }
}

export async function createFlow(workspaceId: string, input: unknown, opts: { userId?: string | null } = {}) {
  const parsed = createFlowSchema.safeParse(input);
  if (!parsed.success) throw badRequest(firstIssue(parsed.error));
  const body = parsed.data;
  await ownedAccount(workspaceId, body.instagramAccountId);

  let graph: FlowGraph;
  let source: VersionRow["source"] = "MANUAL";
  let name = body.name;
  let prompt: string | null = null;
  let changeNote = body.changeNote ?? "Birinchi versiya";
  let aiWarnings: string[] = [];

  if (body.fromTemplateKey) {
    const key = body.fromTemplateKey;
    const starter = findStarterTemplate(key);
    if (starter) {
      graph = starter.graph;
      name ??= starter.name;
      await ensureTemplateTags(workspaceId, starter.tags);
    } else {
      const saved = await prisma.flowTemplate.findFirst({ where: { key, OR: [{ workspaceId }, { workspaceId: null }] } });
      if (!saved) throw notFound(TEMPLATE_NOT_FOUND);
      const g = flowGraphDraftSchema.safeParse(saved.graph);
      if (!g.success) throw unprocessable("Shablon buzilgan");
      graph = g.data;
      name ??= saved.name;
    }
    source = "TEMPLATE";
    changeNote = `Shablondan: ${key}`;
  } else if (body.prompt && body.graph === undefined) {
    const generated = await generateFlowFromPrompt(workspaceId, { request: body.prompt, accountId: body.instagramAccountId, triggerType: body.triggerType });
    graph = generated.graph;
    name ??= generated.name;
    source = "AI";
    prompt = body.prompt;
    aiWarnings = generated.warnings;
    changeNote = "AI yaratgan qoralama";
  } else if (body.graph !== undefined) {
    const g = flowGraphDraftSchema.safeParse(body.graph);
    if (!g.success) throw badRequest(firstIssue(g.error));
    graph = g.data;
    if (body.prompt) {
      source = "AI";
      prompt = body.prompt;
      changeNote = "AI yaratgan qoralama";
    }
  } else {
    graph = blankGraph(body.triggerType);
  }
  name ??= "Yangi oqim";

  const trigger = triggerTypeOf(graph) ?? body.triggerType ?? "DIRECT_MESSAGE";
  const flow = (await prisma.flow.create({
    data: {
      workspaceId,
      instagramAccountId: body.instagramAccountId,
      name,
      mode: body.mode,
      status: "DRAFT",
      triggerType: trigger,
      createdByUserId: opts.userId ?? null,
    },
  })) as unknown as FlowRow;
  const version = (await prisma.flowVersion.create({
    data: {
      flowId: flow.id,
      version: 1,
      schemaVersion: graph.v,
      graph: graph as unknown as Prisma.InputJsonValue,
      hash: hashGraph(graph),
      source,
      prompt,
      changeNote,
    },
  })) as unknown as VersionRow;
  await prisma.flow.update({ where: { id: flow.id }, data: { draftVersionId: version.id } });
  flow.draftVersionId = version.id;
  const evaluation = await evaluate(flow, graph);
  await storeEvaluation(version, evaluation);
  return { flow: { ...flow, draftVersionId: version.id }, version: summarize(flow, version), graph, evaluation, warnings: aiWarnings };
}

export interface FlowListItem {
  id: string;
  name: string;
  mode: FlowRow["mode"];
  status: FlowRow["status"];
  triggerType: string;
  instagramAccountId: string;
  accountUsername: string | null;
  draftVersion: number | null;
  publishedVersion: number | null;
  lastPublishedAt: Date | null;
  runs30d: number;
  activeRuns: number;
  updatedAt: Date;
  createdAt: Date;
}

/** Number of flows matching the same status / account filter as listFlows. */
export async function countFlows(workspaceId: string, filter: { status?: string; accountId?: string } = {}): Promise<number> {
  const where: Record<string, unknown> = { workspaceId };
  if (filter.status) where.status = filter.status;
  if (filter.accountId) where.instagramAccountId = filter.accountId;
  return prisma.flow.count({ where });
}

export async function listFlows(workspaceId: string, filter: { status?: string; accountId?: string; limit?: number } = {}): Promise<FlowListItem[]> {
  const where: Record<string, unknown> = { workspaceId };
  if (filter.status) where.status = filter.status;
  if (filter.accountId) where.instagramAccountId = filter.accountId;
  const take = Math.min(Math.max(filter.limit ?? 500, 1), 500);
  const flows = (await prisma.flow.findMany({ where, orderBy: { updatedAt: "desc" }, take })) as unknown as FlowRow[];
  if (flows.length === 0) return [];
  const flowIds = flows.map((f) => f.id);
  const [accounts, versions, runs] = await Promise.all([
    prisma.instagramAccount.findMany({ where: { workspaceId }, select: { id: true, username: true } }),
    prisma.flowVersion.findMany({ where: { flowId: { in: flowIds } }, select: { id: true, flowId: true, version: true, publishedAt: true } }),
    prisma.flowRun.findMany({
      where: { workspaceId, flowId: { in: flowIds }, OR: [{ startedAt: { gte: new Date(Date.now() - 30 * DAY_MS) } }, { status: { in: [...ACTIVE_RUN_STATUSES] } }] },
      select: { flowId: true, status: true, startedAt: true },
      take: 50_000,
    }),
  ]);
  const username = new Map(accounts.map((a) => [a.id, a.username]));
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const lastPublished = new Map<string, Date>();
  for (const v of versions) {
    if (v.publishedAt && (!lastPublished.get(v.flowId) || v.publishedAt > lastPublished.get(v.flowId)!)) lastPublished.set(v.flowId, v.publishedAt);
  }
  const since = Date.now() - 30 * DAY_MS;
  const runs30 = new Map<string, number>();
  const active = new Map<string, number>();
  for (const r of runs) {
    if (new Date(r.startedAt).getTime() >= since) runs30.set(r.flowId, (runs30.get(r.flowId) ?? 0) + 1);
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(r.status)) active.set(r.flowId, (active.get(r.flowId) ?? 0) + 1);
  }
  return flows.map((f) => ({
    id: f.id,
    name: f.name,
    mode: f.mode,
    status: f.status,
    triggerType: f.triggerType,
    instagramAccountId: f.instagramAccountId,
    accountUsername: username.get(f.instagramAccountId) ?? null,
    draftVersion: f.draftVersionId ? (versionById.get(f.draftVersionId)?.version ?? null) : null,
    publishedVersion: f.publishedVersionId ? (versionById.get(f.publishedVersionId)?.version ?? null) : null,
    lastPublishedAt: lastPublished.get(f.id) ?? null,
    runs30d: runs30.get(f.id) ?? 0,
    activeRuns: active.get(f.id) ?? 0,
    updatedAt: f.updatedAt,
    createdAt: f.createdAt,
  }));
}

export async function getFlow(workspaceId: string, flowId: string) {
  const flow = await loadFlow(workspaceId, flowId);
  const [account, versions, runs] = await Promise.all([
    prisma.instagramAccount.findFirst({ where: { id: flow.instagramAccountId, workspaceId }, select: { id: true, username: true } }),
    prisma.flowVersion.findMany({ where: { flowId: flow.id }, orderBy: { version: "desc" } }),
    prisma.flowRun.findMany({ where: { workspaceId, flowId: flow.id, startedAt: { gte: new Date(Date.now() - 30 * DAY_MS) } }, select: { status: true }, take: 50_000 }),
  ]);
  const rows = versions as unknown as VersionRow[];
  const draft = flow.draftVersionId ? rows.find((v) => v.id === flow.draftVersionId && !v.publishedAt) : undefined;
  const published = flow.publishedVersionId ? rows.find((v) => v.id === flow.publishedVersionId) : undefined;
  const byStatus: Record<string, number> = {};
  for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const active = ACTIVE_RUN_STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
  const current = draft ?? published ?? null;
  return {
    flow: { ...flow, accountUsername: account?.username ?? null },
    draft: draft ? { ...summarize(flow, draft), graph: draft.graph, audit: asStoredAudit(draft.auditResult), policy: asStoredPolicy(draft.policyResult), prompt: draft.prompt } : null,
    published: published ? { ...summarize(flow, published), graph: published.graph } : null,
    // What the editor opens: the draft, else the published version (read-only until the first save opens a draft).
    current: current ? { versionId: current.id, graph: current.graph, editable: current === draft } : null,
    versionCount: rows.length,
    stats: { runs30d: runs.length, activeRuns: active, byStatus },
  };
}

// ─── Draft ────────────────────────────────────────────────────────────────────

export const saveDraftSchema = z.object({
  graph: z.unknown(),
  changeNote: z.string().max(200).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  mode: flowModeSchema.optional(),
});

export async function saveDraft(workspaceId: string, flowId: string, input: unknown) {
  const body = saveDraftSchema.safeParse(input);
  if (!body.success) throw badRequest(firstIssue(body.error));
  const flow = await loadFlow(workspaceId, flowId);
  if (flow.status === "ARCHIVED") throw unprocessable(FLOW_ARCHIVED);
  const parsed = flowGraphDraftSchema.safeParse(body.data.graph);
  if (!parsed.success) throw badRequest(firstIssue(parsed.error));
  const graph = parsed.data;
  const hash = hashGraph(graph);

  const draftRow = flow.draftVersionId ? await prisma.flowVersion.findFirst({ where: { id: flow.draftVersionId, flowId: flow.id } }) : null;
  const draft = draftRow && !(draftRow as unknown as VersionRow).publishedAt ? (draftRow as unknown as VersionRow) : null;
  const latest = (await prisma.flowVersion.findMany({ where: { flowId: flow.id }, orderBy: { version: "desc" }, take: 1 })) as unknown as VersionRow[];
  const base = draft ?? latest[0] ?? null;
  const hashChanged = !base || base.hash !== hash;
  // A template graph the merchant edited is hand-built from then on; AI stays AI (approval rule).
  const source: VersionRow["source"] = base ? (base.source === "TEMPLATE" && hashChanged ? "MANUAL" : base.source) : "MANUAL";

  let version: VersionRow;
  if (draft) {
    const data: Record<string, unknown> = { graph: graph as unknown as Prisma.InputJsonValue, hash, source };
    if (body.data.changeNote !== undefined) data.changeNote = body.data.changeNote;
    if (hash !== draft.hash) {
      data.testedAt = null;
      data.approvedAt = null;
      data.approvedByUserId = null;
    }
    version = (await prisma.flowVersion.update({ where: { id: draft.id }, data })) as unknown as VersionRow;
  } else {
    const next = (latest[0]?.version ?? 0) + 1;
    version = (await prisma.flowVersion.create({
      data: {
        flowId: flow.id,
        version: next,
        schemaVersion: graph.v,
        graph: graph as unknown as Prisma.InputJsonValue,
        hash,
        source,
        prompt: latest[0]?.source === "AI" ? (latest[0]?.prompt ?? null) : null,
        changeNote: body.data.changeNote ?? `v${next} qoralama`,
      },
    })) as unknown as VersionRow;
  }

  const flowData: Record<string, unknown> = { draftVersionId: version.id };
  const trigger = triggerTypeOf(graph);
  if (trigger) flowData.triggerType = trigger;
  if (body.data.name) flowData.name = body.data.name;
  if (body.data.mode) flowData.mode = body.data.mode;
  // A changed graph is no longer the approved one.
  if (flow.status === "REVIEW" && hashChanged) flowData.status = "DRAFT";
  const updatedFlow = (await prisma.flow.update({ where: { id: flow.id }, data: flowData })) as unknown as FlowRow;

  const evaluation = await evaluate(updatedFlow, graph);
  await storeEvaluation(version, evaluation);
  return { flow: updatedFlow, version: summarize(updatedFlow, version), evaluation, opened: draft ? "updated" : "new_version" };
}

export async function renameFlow(workspaceId: string, flowId: string, input: unknown) {
  // Partial update: the mode switch sends only { mode }, a rename only { name }.
  const parsed = z
    .object({ name: z.string().trim().min(1, "Nom kiritilmagan").max(120).optional(), mode: flowModeSchema.optional() })
    .refine((v) => v.name !== undefined || v.mode !== undefined, { message: "Nom yoki rejim ko'rsatilmagan" })
    .safeParse(input);
  if (!parsed.success) throw badRequest(firstIssue(parsed.error));
  await loadFlow(workspaceId, flowId);
  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.mode) data.mode = parsed.data.mode;
  return prisma.flow.update({ where: { id: flowId }, data });
}

// ─── Versions, diff ───────────────────────────────────────────────────────────

export async function listVersions(workspaceId: string, flowId: string): Promise<VersionSummary[]> {
  const flow = await loadFlow(workspaceId, flowId);
  const rows = (await prisma.flowVersion.findMany({ where: { flowId: flow.id }, orderBy: { version: "desc" } })) as unknown as VersionRow[];
  return rows.map((v) => summarize(flow, v));
}

export async function getVersion(workspaceId: string, flowId: string, versionId: string) {
  const { flow, version } = await loadVersion(workspaceId, flowId, versionId);
  return {
    ...summarize(flow, version),
    graph: version.graph,
    prompt: version.prompt,
    audit: asStoredAudit(version.auditResult),
    policy: asStoredPolicy(version.policyResult),
  };
}

export async function diffVersions(workspaceId: string, flowId: string, a: string, b: string): Promise<{ a: VersionSummary; b: VersionSummary; diff: GraphDiff }> {
  const [left, right] = await Promise.all([loadVersion(workspaceId, flowId, a), loadVersion(workspaceId, flowId, b)]);
  return { a: summarize(left.flow, left.version), b: summarize(right.flow, right.version), diff: diffGraphs(graphOf(left.version), graphOf(right.version)) };
}

/** Restores an older version as the (new) draft. The draft is overwritten in place when it is unpublished. */
export async function restoreVersion(workspaceId: string, flowId: string, versionId: string) {
  const { version } = await loadVersion(workspaceId, flowId, versionId);
  const saved = await saveDraft(workspaceId, flowId, { graph: graphOf(version), changeNote: `v${version.version} qayta tiklandi` });
  // The restored draft is the SAME graph (same hash) as a version that was tested or already went live:
  // it carries that proof over, so it can be published again without a new sandbox run. Editing it
  // afterwards resets testedAt (saveDraft), as for any version.
  const proof = previousTestProof(version);
  if (proof && saved.version.id !== version.id) {
    const fresh = (await prisma.flowVersion.findFirst({ where: { id: saved.version.id } })) as unknown as VersionRow | null;
    if (fresh && fresh.hash === version.hash && !fresh.testedAt) {
      await prisma.flowVersion.update({ where: { id: fresh.id }, data: { testedAt: proof } });
      return { ...saved, version: { ...saved.version, testedAt: proof } };
    }
  }
  return saved;
}

/**
 * M6: versions published BEFORE the test gate existed have testedAt = null. A version that was
 * already published (publishedAt != null) is exempt from the "must be tested" rule on republish;
 * new and edited versions (never published, testedAt reset by a changed hash) still need a
 * passing sandbox run. AI versions keep their own rule (test + approval) either way.
 */
function previousTestProof(version: VersionRow): Date | null {
  if (version.testedAt) return version.testedAt;
  if (version.publishedAt && version.source !== "AI") return version.publishedAt;
  return null;
}


// ─── Test ─────────────────────────────────────────────────────────────────────

export const testInputSchema = z.object({
  contact: z.object({ name: z.string().max(80).optional(), phone: z.string().max(30).optional() }).optional(),
  inbound: z.array(z.object({ text: z.string().max(1000) })).max(20).optional(),
  taps: z.array(z.string().max(80)).max(20).optional(),
  window: z.enum(["open", "closed"]).optional(),
  vars: z.record(z.string().max(40), z.string().max(500)).optional(),
});

type SandboxLike = { status?: unknown; steps?: unknown; endedAt?: unknown; [k: string]: unknown };

/** A sandbox run counts as passed when it ended and no step failed. */
export function sandboxPassed(result: SandboxLike): boolean {
  const status = String(result.status ?? "").toUpperCase();
  if (status === "FAILED" || status === "ERROR" || status === "LOOP" || status === "STEP_LIMIT") return false;
  const steps = Array.isArray(result.steps) ? (result.steps as Array<{ status?: unknown; error?: unknown }>) : [];
  return !steps.some((s) => String(s.status ?? "").toUpperCase() === "FAILED" || Boolean(s.error));
}

export async function testVersion(workspaceId: string, flowId: string, versionId: string, input: unknown) {
  const parsed = testInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw badRequest(firstIssue(parsed.error));
  const { version } = await loadVersion(workspaceId, flowId, versionId);
  const graph = graphOf(version);
  const result = (await runFlowSandbox(workspaceId, graph, parsed.data)) as unknown as SandboxLike;
  const passed = sandboxPassed(result);
  // Only a clean run of the CURRENT hash counts; a version that was edited meanwhile keeps testedAt = null.
  const fresh = await prisma.flowVersion.findFirst({ where: { id: version.id, flowId } });
  let testedAt: Date | null = (fresh as unknown as VersionRow | null)?.testedAt ?? null;
  if (passed && fresh && (fresh as unknown as VersionRow).hash === version.hash) {
    testedAt = new Date();
    await prisma.flowVersion.update({ where: { id: version.id }, data: { testedAt } });
  }
  return { result, passed, testedAt };
}

// ─── Approve / publish ────────────────────────────────────────────────────────

export const NOT_APPROVABLE_AUDIT = "Audit xatolari bor — avval ularni tuzating";
export const NOT_APPROVABLE_POLICY = "Policy BLOCKED — xabar yuborish qoidalari buzilgan, tasdiqlab bo'lmaydi";
export const NEEDS_TEST = "AI yaratgan versiyani tasdiqlashdan oldin Test konsolida muvaffaqiyatli sinab ko'ring";
export const NEEDS_TEST_PUBLISH = "Ishga tushirishdan oldin joriy versiyani Test konsolida muvaffaqiyatli sinab ko'ring (matn o'zgarsa, sinov bekor bo'ladi)";
export const NEEDS_APPROVAL = "AI yaratgan versiya tasdiqsiz ishga tushmaydi — avval tasdiqlang";
export const NEEDS_ACK = "Ogohlantirishlar bor — ularni ko'rib chiqqaningizni tasdiqlang";

export async function approveVersion(workspaceId: string, versionId: string, userId: string) {
  const version = (await prisma.flowVersion.findFirst({ where: { id: versionId } })) as unknown as VersionRow | null;
  if (!version) throw notFound(VERSION_NOT_FOUND);
  const flow = await loadFlow(workspaceId, version.flowId); // foreign workspace → 404
  if (flow.status === "ARCHIVED") throw unprocessable(FLOW_ARCHIVED);
  if (version.publishedAt) throw unprocessable("Bu versiya allaqachon ishga tushirilgan");
  const evaluation = await evaluate(flow, graphOf(version));
  await storeEvaluation(version, evaluation);
  if (evaluation.structural.length > 0) throw unprocessable(`Graf to'liq emas: ${evaluation.structural[0]}`);
  if (evaluation.audit.errors.length > 0) throw unprocessable(NOT_APPROVABLE_AUDIT);
  if (evaluation.policy.verdict === "BLOCKED") throw unprocessable(NOT_APPROVABLE_POLICY);
  if (version.source === "AI" && !version.testedAt) throw unprocessable(NEEDS_TEST);
  const approvedAt = new Date();
  const updated = (await prisma.flowVersion.update({ where: { id: version.id }, data: { approvedAt, approvedByUserId: userId } })) as unknown as VersionRow;
  if (flow.status === "DRAFT") await prisma.flow.update({ where: { id: flow.id }, data: { status: "REVIEW" } });
  return { ...summarize(flow, updated), evaluation };
}

export const publishInputSchema = z.object({ acknowledgeWarnings: z.boolean().optional() }).default({});

export async function publishVersion(workspaceId: string, flowId: string, versionId: string, input: unknown, userId: string) {
  const parsed = publishInputSchema.safeParse(input ?? {});
  if (!parsed.success) throw badRequest(firstIssue(parsed.error));
  const { flow, version } = await loadVersion(workspaceId, flowId, versionId);
  if (flow.status === "ARCHIVED") throw unprocessable(FLOW_ARCHIVED);
  if (!isFlowsEnabled()) throw new FlowServiceError(503, "Flow'lar o'chirilgan (FLOWS_DISABLED) — ishga tushirib bo'lmaydi");
  const evaluation = await evaluate(flow, graphOf(version));
  await storeEvaluation(version, evaluation);
  if (evaluation.structural.length > 0) throw unprocessable(`Graf to'liq emas: ${evaluation.structural[0]}`);
  if (evaluation.audit.errors.length > 0) throw unprocessable(NOT_APPROVABLE_AUDIT);
  if (evaluation.policy.verdict === "BLOCKED") throw unprocessable(NOT_APPROVABLE_POLICY);
  // Every version needs a clean sandbox run of its CURRENT hash (testedAt is reset by a changed hash).
  // (M6: a previously published non-AI version is exempt, see previousTestProof.)
  if (!previousTestProof(version)) throw unprocessable(version.source === "AI" ? NEEDS_TEST : NEEDS_TEST_PUBLISH);
  if (version.source === "AI" && !version.testedAt) throw unprocessable(NEEDS_TEST);
  if (version.source === "AI" && !version.approvedAt) throw unprocessable(NEEDS_APPROVAL);
  if (evaluation.policy.verdict === "WARNING" && !parsed.data.acknowledgeWarnings) throw unprocessable(NEEDS_ACK);
  const result = (await publishFlowVersion(workspaceId, flowId, versionId, { userId })) as unknown as { ok: boolean; status?: number; error?: string; flow?: unknown };
  if (!result.ok) throw new FlowServiceError(result.status ?? 422, result.error ?? "Ishga tushirib bo'lmadi");
  return { flow: result.flow ?? null, versionId, evaluation };
}

export async function unpublish(workspaceId: string, flowId: string, to: "DRAFT" | "ARCHIVED" = "DRAFT") {
  const flow = await loadFlow(workspaceId, flowId);
  if (flow.status !== "PUBLISHED") throw unprocessable("Oqim ishga tushirilmagan");
  const result = (await unpublishFlow(workspaceId, flowId, to)) as unknown as { ok?: boolean; status?: number; error?: string } | undefined;
  if (result && result.ok === false) throw new FlowServiceError(result.status ?? 422, result.error ?? "To'xtatib bo'lmadi");
  return getFlow(workspaceId, flowId);
}

export async function archive(workspaceId: string, flowId: string) {
  await loadFlow(workspaceId, flowId);
  const result = (await archiveFlow(workspaceId, flowId)) as unknown as { ok?: boolean; status?: number; error?: string } | undefined;
  if (result && result.ok === false) throw new FlowServiceError(result.status ?? 422, result.error ?? "Arxivlab bo'lmadi");
  return getFlow(workspaceId, flowId);
}

export async function deleteFlow(workspaceId: string, flowId: string) {
  const flow = await loadFlow(workspaceId, flowId);
  if (flow.status !== "DRAFT" && flow.status !== "ARCHIVED") {
    throw unprocessable("Faqat qoralama yoki arxivdagi oqimni o'chirish mumkin — avval to'xtating yoki arxivlang");
  }
  const runs = await prisma.flowRun.count({ where: { workspaceId, flowId } });
  if (runs > 0) throw unprocessable(`Oqimda ${runs} ta ishga tushish tarixi bor — o'chirib bo'lmaydi, arxivda qoldiring`);
  await prisma.flowVersion.deleteMany({ where: { flowId } });
  await prisma.flow.delete({ where: { id: flowId } });
  return { deleted: true };
}

// ─── Templates ────────────────────────────────────────────────────────────────

export interface TemplateItem {
  key: string;
  id: string | null;
  name: string;
  description: string | null;
  category: string;
  triggerType: string | null;
  tags: string[];
  builtIn: boolean;
  nodeCount: number;
  graph: unknown;
}

export async function listTemplates(workspaceId: string): Promise<TemplateItem[]> {
  const starters: TemplateItem[] = FLOW_STARTER_TEMPLATES.map((t) => ({
    key: t.key,
    id: null,
    name: t.name,
    description: t.description,
    category: t.category,
    triggerType: t.triggerType,
    tags: t.tags,
    builtIn: true,
    nodeCount: t.graph.nodes.length,
    graph: t.graph,
  }));
  const saved = await prisma.flowTemplate.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100 });
  return [
    ...starters,
    ...saved.map((t) => {
      const g = flowGraphDraftSchema.safeParse(t.graph);
      return {
        key: t.key,
        id: t.id,
        name: t.name,
        description: t.description ?? null,
        category: t.category,
        triggerType: g.success ? triggerTypeOf(g.data) : null,
        tags: [],
        builtIn: false,
        nodeCount: g.success ? g.data.nodes.length : 0,
        graph: t.graph,
      };
    }),
  ];
}

export const saveTemplateSchema = z.object({
  flowId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  name: z.string().trim().min(1, "Shablon nomi kiritilmagan").max(120),
  description: z.string().trim().max(300).optional(),
  category: z.enum(["sales", "story", "ads", "faq", "giveaway"]).default("sales"),
});

export async function saveAsTemplate(workspaceId: string, input: unknown) {
  const parsed = saveTemplateSchema.safeParse(input);
  if (!parsed.success) throw badRequest(firstIssue(parsed.error));
  const flow = await loadFlow(workspaceId, parsed.data.flowId);
  const id = parsed.data.versionId ?? flow.draftVersionId ?? flow.publishedVersionId;
  if (!id) throw notFound(VERSION_NOT_FOUND);
  const { version } = await loadVersion(workspaceId, flow.id, id);
  const graph = graphOf(version);
  const structure = flowGraphSchema.safeParse(graph);
  if (!structure.success) throw unprocessable(`Shablon sifatida faqat to'liq oqimni saqlash mumkin: ${structure.error.issues[0]?.message ?? "graf to'liq emas"}`);
  const slug = parsed.data.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  const key = `ws:${workspaceId.slice(-8)}:${slug || "shablon"}:${Date.now().toString(36)}`;
  const row = await prisma.flowTemplate.create({
    data: {
      workspaceId,
      key,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      category: parsed.data.category,
      graph: { ...graph, layout: undefined } as unknown as Prisma.InputJsonValue,
      schemaVersion: graph.v,
    },
  });
  return { id: row.id, key: row.key, name: row.name };
}

export async function deleteTemplate(workspaceId: string, templateId: string) {
  const row = await prisma.flowTemplate.findFirst({ where: { id: templateId, workspaceId } });
  if (!row) throw notFound(TEMPLATE_NOT_FOUND);
  await prisma.flowTemplate.delete({ where: { id: templateId } });
  return { deleted: true };
}

// ─── Meta (the editor's one call) ─────────────────────────────────────────────

export async function meta(workspaceId: string) {
  const [accounts, jaAccounts, tags, pipelines, members] = await Promise.all([
    prisma.instagramAccount.findMany({ where: { workspaceId }, orderBy: { connectedAt: "desc" }, select: { id: true, username: true, tokenStatus: true } }),
    prisma.javobAiAccount.findMany({ where: { workspaceId }, select: { instagramAccountId: true, mode: true } }),
    prisma.crmTag.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } }),
    prisma.crmPipeline.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, select: { id: true, name: true, isDefault: true } }),
    prisma.workspaceMember.findMany({ where: { workspaceId }, select: { id: true, role: true, user: { select: { name: true, email: true } } } }),
  ]);
  const pipelineIds = pipelines.map((p) => p.id);
  const stages = pipelineIds.length ? await prisma.crmStage.findMany({ where: { pipelineId: { in: pipelineIds } }, orderBy: { sort: "asc" } }) : [];
  const jaMode = new Map(jaAccounts.map((a) => [a.instagramAccountId, a.mode]));
  const limits = {
    nodes: FLOW_LIMITS.nodes,
    edges: FLOW_LIMITS.edges,
    variables: FLOW_LIMITS.variables,
    messageLength: FLOW_LIMITS.messageLength,
    buttonTemplateTextLength: FLOW_LIMITS.buttonTemplateTextLength,
    buttonLabelLength: FLOW_LIMITS.buttonLabelLength,
    quickReplies: FLOW_LIMITS.quickReplies,
    publicReplyLength: FLOW_LIMITS.publicReplyLength,
    branches: FLOW_LIMITS.branches,
    delayMaxMinutes: FLOW_LIMITS.delayMaxMinutes,
    windowMinutes: FLOW_LIMITS.windowMinutes,
  };
  return {
    disabled: !isFlowsEnabled(),
    accounts: accounts.map((a) => ({ id: a.id, username: a.username, tokenStatus: a.tokenStatus, javobAiMode: (jaMode.get(a.id) ?? "OFF") as "OFF" | "SHADOW" | "LIVE" })),
    tags,
    pipelines: pipelines.map((p) => ({ ...p, stages: stages.filter((s) => s.pipelineId === p.id).map((s) => ({ id: s.id, name: s.name, kind: s.kind, isEntry: s.isEntry })) })),
    members: members.map((m) => ({ id: m.id, name: m.user?.name ?? m.user?.email ?? "A'zo", role: m.role })),
    intents: BUILT_IN_INTENTS.map((i) => ({ key: i.key, label: i.label })),
    nodeLabels: NODE_LABELS,
    triggerLabels: TRIGGER_TYPE_LABELS,
    limits,
    fieldSpecs: FIELD_SPECS,
    operators: FLOW_OPERATORS,
    variables: VARIABLE_SPECS,
  };
}
