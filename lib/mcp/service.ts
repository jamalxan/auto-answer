/**
 * ETAP 12 — the workspace-scoped data layer behind the MCP tools.
 *
 * Rules (tenant isolation is the first review item):
 *  - every function takes the workspaceId of the TOKEN and passes it to an
 *    existing, already workspace-scoped service (comment-service, flows
 *    service, crm contacts / tags, analytics read, foundation diagnostics);
 *    this file adds no raw cross-workspace query;
 *  - ids coming from the AI client are only ever looked up together with that
 *    workspaceId, so a foreign id reads as "not found";
 *  - what leaves is a whitelist: no tokens, no phone / email, no encrypted
 *    columns, no platform-wide numbers;
 *  - writes here are the EXECUTORS: they are reached only through
 *    confirm_action (lib/mcp/confirm.ts) after a stored, single-use preview.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { formatMetric, type AnalyticsTab } from "@/lib/analytics/catalog";
import { loadKpi } from "@/lib/analytics/kpi";
import { readAnalytics, type AnalyticsResult } from "@/lib/analytics/read";
import { getContact, listContacts, setContactStatus } from "@/lib/crm/contacts";
import { addTag, ensureTag, findTag } from "@/lib/crm/tags";
import { loadConnections } from "@/lib/foundation/connections";
import { runDiagnostics } from "@/lib/foundation/diagnostics";
import { generateFlowFromPrompt } from "@/lib/flows/ai-builder";
import { auditGraph, type AuditResult } from "@/lib/flows/audit";
import { auditContextFrom, loadFlowContext } from "@/lib/flows/context";
import { evaluatePolicy, type PolicyResult } from "@/lib/flows/policy";
import { FLOW_TRIGGER_TYPES, flowGraphDraftSchema, sendText, type FlowGraph } from "@/lib/flows/schema";
import { createFlow, getFlow, listFlows } from "@/lib/flows/service";
import { loadKnowledgeBlock } from "@/lib/javobai/knowledge";
import { findProfile } from "@/lib/assistant/profile";
import { accountInWorkspace } from "@/lib/triggers/campaign-editing";
import {
  commentCampaignSchema,
  createCommentCampaign,
  getCommentCampaign,
  listCommentCampaigns,
  saveVariants,
  setCommentCampaignActive,
  updateCommentCampaign,
  type VariantInput,
} from "@/lib/triggers/comment-service";
import { badRequest, McpServiceError, notFound } from "./errors";

export const CAMPAIGN_NOT_FOUND = "Kampaniya topilmadi";
export const FLOW_NOT_FOUND = "Oqim topilmadi";
export const LEAD_NOT_FOUND = "Lead topilmadi";
export const ACCOUNT_NOT_FOUND = "Instagram akkaunt topilmadi";

const clip = (text: string | null | undefined, max: number): string | null => {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

function unwrap<T>(result: { ok: true; data: T } | { ok: false; status: number; error: string }): T {
  if (!result.ok) throw new McpServiceError(result.status, result.error);
  return result.data;
}

// ─── Instagram accounts / diagnostics / analytics ─────────────────────────────

export async function listAccountsView(workspaceId: string) {
  const connections = await loadConnections(workspaceId);
  return connections.map((c) => ({
    id: c.id,
    username: c.username,
    status: c.status,
    webhookSubscribed: c.webhookSubscribed,
    tokenExpiresAt: c.tokenExpiresAt,
    connectedAt: c.connectedAt,
  }));
}

export async function diagnosticsView(workspaceId: string) {
  const items = await runDiagnostics(workspaceId);
  return items.map((item) => ({
    key: item.key,
    label: item.label,
    status: item.status,
    value: item.value,
    meaning: item.meaning,
    issue: item.issue,
    action: item.action?.label ?? null,
    lastCheck: item.lastCheck,
  }));
}

export async function kpiView(workspaceId: string) {
  const kpi = await loadKpi(workspaceId);
  // queueDepths is platform-wide (every workspace's queues): never part of a tenant answer.
  const { queueDepths: _platformWide, ...own } = kpi;
  void _platformWide;
  return own;
}

export const PERIODS = ["today", "7d", "30d"] as const;
export type Period = (typeof PERIODS)[number];

async function readTab(workspaceId: string, tab: AnalyticsTab, preset: Period, accountId: string | null): Promise<AnalyticsResult> {
  const result = await readAnalytics(workspaceId, { tab, preset, accountId, compare: "previous", mode: "period" });
  if (!result.ok) throw new McpServiceError(result.status, result.error);
  return result.data;
}

function metricRows(data: AnalyticsResult) {
  return Object.entries(data.metrics).map(([key, m]) => ({
    key,
    label: m.label,
    value: m.value,
    formatted: formatMetric(m.value, m.format),
    previous: m.compare,
    deltaPct: m.deltaPct,
  }));
}

export async function analyticsView(workspaceId: string, input: { tab: AnalyticsTab; period: Period; accountId?: string | null }) {
  const data = await readTab(workspaceId, input.tab, input.period, input.accountId ?? null);
  return {
    tab: data.tab,
    range: data.range,
    compareWith: data.compare?.label ?? null,
    metrics: metricRows(data),
    topBreakdown: data.breakdown.slice(0, 10).map((row) => ({ kind: row.dimKind, label: row.label, metrics: row.metrics })),
    notes: data.notes,
  };
}

/** A plain-text period report (Uzbek) built from the same numbers as the analytics screen. */
export async function reportText(workspaceId: string, input: { period: Period; accountId?: string | null }): Promise<string> {
  const tabs: Array<{ tab: AnalyticsTab; title: string }> = [
    { tab: "campaign", title: "Kampaniyalar" },
    { tab: "ai", title: "AI" },
    { tab: "sales", title: "Sotuv" },
  ];
  const label = input.period === "today" ? "Bugun" : input.period === "7d" ? "So'nggi 7 kun" : "So'nggi 30 kun";
  const lines: string[] = [`SocialAuto hisoboti — ${label}`];
  for (const { tab, title } of tabs) {
    const data = await readTab(workspaceId, tab, input.period, input.accountId ?? null);
    if (tab === "campaign") lines.push(`(${data.range.from} — ${data.range.to})`);
    lines.push("", `${title}:`);
    for (const row of metricRows(data)) {
      const delta = row.deltaPct === null ? "" : ` (${row.deltaPct > 0 ? "+" : ""}${row.deltaPct}% oldingi davrga nisbatan)`;
      lines.push(`- ${row.label}: ${row.formatted}${delta}`);
    }
    for (const note of data.notes) lines.push(`  Eslatma: ${note}`);
  }
  return lines.join("\n");
}

// ─── Campaigns (comment campaigns) ────────────────────────────────────────────

export async function listCampaignsView(workspaceId: string, input: { status: "all" | "active" | "paused"; limit: number }) {
  const all = await listCommentCampaigns(workspaceId);
  const filtered = all.filter((c) => (input.status === "all" ? true : input.status === "active" ? c.active : !c.active));
  return {
    total: filtered.length,
    campaigns: filtered.slice(0, input.limit).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.active ? "ACTIVE" : "PAUSED",
      triggerType: c.triggerType,
      account: c.instagramAccount.username,
      matchingMode: c.matchingMode,
      keywords: c.keywords,
      stats: { executions: c.stats.executions, opened: c.stats.opened, leads: c.stats.leads },
    })),
  };
}

export async function campaignView(workspaceId: string, campaignId: string) {
  const c = await getCommentCampaign(workspaceId, campaignId);
  if (!c) throw notFound(CAMPAIGN_NOT_FOUND);
  return {
    id: c.id,
    name: c.name,
    status: c.active ? "ACTIVE" : "PAUSED",
    triggerType: c.triggerType,
    account: c.instagramAccount.username,
    matchingMode: c.matchingMode,
    keywords: c.keywords,
    intents: c.intents,
    mediaScope: c.mediaScope,
    publicReplyEnabled: c.publicReplyEnabled,
    dmMessage: c.responseMessage,
    openingButtonLabel: c.openingButtonLabel,
    mainMessage: c.mainMessage,
    replyMode: c.replyMode,
    variants: c.replyVariants.map((v) => ({ kind: v.kind, text: v.text, approved: Boolean(v.approvedAt) })),
    quickReplies: c.quickReplies.length,
    followUpSteps: c.followUpSteps.length,
    createdAt: iso(c.createdAt),
  };
}

// ─── Flows ────────────────────────────────────────────────────────────────────

export async function listFlowsView(workspaceId: string, input: { status?: string; limit: number }) {
  const flows = await listFlows(workspaceId, input.status ? { status: input.status } : {});
  return {
    total: flows.length,
    flows: flows.slice(0, input.limit).map((f) => ({
      id: f.id,
      name: f.name,
      status: f.status,
      triggerType: f.triggerType,
      account: f.accountUsername,
      draftVersion: f.draftVersion,
      publishedVersion: f.publishedVersion,
      runs30d: f.runs30d,
      updatedAt: iso(f.updatedAt),
    })),
  };
}

export function graphSummary(graph: FlowGraph) {
  const counts: Record<string, number> = {};
  for (const node of graph.nodes) counts[node.type] = (counts[node.type] ?? 0) + 1;
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  return {
    trigger: trigger && trigger.type === "trigger" ? { type: trigger.triggerType, matchingMode: trigger.matchingMode, keywords: trigger.keywords ?? [] } : null,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    nodeTypes: counts,
    messages: graph.nodes
      .map((n) => ({ id: n.id, type: n.type, text: clip(sendText(n), 200) }))
      .filter((n) => n.text)
      .slice(0, 12),
  };
}

function findingsView(audit: Pick<AuditResult, "errors" | "warnings" | "suggestions">, policy: PolicyResult) {
  return {
    audit: {
      errors: audit.errors.slice(0, 8).map((f) => f.message),
      warnings: audit.warnings.slice(0, 8).map((f) => f.message),
      suggestions: audit.suggestions.length,
    },
    policy: { verdict: policy.verdict, items: policy.items.slice(0, 8).map((i) => ({ severity: i.severity, message: i.message })) },
  };
}

export async function flowView(workspaceId: string, flowId: string) {
  let detail: Awaited<ReturnType<typeof getFlow>>;
  try {
    detail = await getFlow(workspaceId, flowId);
  } catch (error) {
    if (error instanceof McpServiceError) throw error;
    // FlowServiceError 404 for a foreign / missing id: say the same thing either way.
    if ((error as { status?: number } | null)?.status === 404) throw notFound(FLOW_NOT_FOUND);
    throw error;
  }
  const parsedDraft = detail.draft ? flowGraphDraftSchema.safeParse(detail.draft.graph) : null;
  const parsedPublished = detail.published ? flowGraphDraftSchema.safeParse(detail.published.graph) : null;
  return {
    id: detail.flow.id,
    name: detail.flow.name,
    status: detail.flow.status,
    triggerType: detail.flow.triggerType,
    account: detail.flow.accountUsername,
    versionCount: detail.versionCount,
    stats: detail.stats,
    draft: detail.draft
      ? {
          version: detail.draft.version,
          source: detail.draft.source,
          graph: parsedDraft?.success ? graphSummary(parsedDraft.data) : null,
          audit: detail.draft.audit
            ? { errors: detail.draft.audit.errors.slice(0, 8).map((f) => f.message), warnings: detail.draft.audit.warnings.slice(0, 8).map((f) => f.message) }
            : null,
          policyVerdict: detail.draft.policy?.verdict ?? null,
        }
      : null,
    published: detail.published ? { version: detail.published.version, graph: parsedPublished?.success ? graphSummary(parsedPublished.data) : null } : null,
  };
}

// ─── Leads (CRM contacts) ─────────────────────────────────────────────────────

export const LEAD_STAGES = ["NEW", "ACTIVE", "CUSTOMER", "LOST", "ARCHIVED"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export interface ListLeadsInput {
  stage?: LeadStage;
  tag?: string;
  search?: string;
  since?: string;
  until?: string;
  limit: number;
  cursor?: string;
}

/**
 * Minimal lead card: name, username, stage, tags, last activity, temperature.
 * No phone, email, ids of the Instagram user or custom fields.
 */
export async function listLeadsView(workspaceId: string, input: ListLeadsInput) {
  const filter: Record<string, unknown> = {};
  if (input.stage) filter.status = input.stage;
  if (input.tag) {
    const tag = await findTag(workspaceId, input.tag);
    // An unknown tag matches nobody (and is not an error: the client may be probing a name).
    filter.tags = { some: { tagId: tag?.id ?? "__none__" } };
  }
  const range: Record<string, Date> = {};
  if (input.since) range.gte = new Date(input.since);
  if (input.until) range.lte = new Date(input.until);
  if (Object.keys(range).length > 0) filter.lastInteractionAt = range;
  const needle = input.search?.trim().replace(/^@/, "");
  if (needle) {
    // Name / username only: searching by phone would let the client probe numbers it cannot read.
    filter.OR = [{ username: { contains: needle, mode: "insensitive" } }, { name: { contains: needle, mode: "insensitive" } }];
  }
  const page = await listContacts(workspaceId, { where: filter as never, limit: input.limit, cursor: input.cursor ?? null });
  return {
    total: page.total,
    nextCursor: page.nextCursor,
    leads: page.items.map((c) => ({
      id: c.id,
      name: c.name,
      username: c.username,
      stage: c.status,
      tags: c.tags.map((t) => t.tag.name),
      lastMessageAt: iso(c.lastInteractionAt),
      temperature: c.temperature,
    })),
  };
}

// ─── Knowledge base ───────────────────────────────────────────────────────────

export async function searchKnowledge(workspaceId: string, input: { accountId?: string; query: string }) {
  if (input.accountId) {
    const account = await accountInWorkspace(workspaceId, input.accountId);
    if (!account) throw notFound(ACCOUNT_NOT_FOUND);
  }
  const profile = await findProfile(workspaceId, input.accountId ?? null);
  if (!profile) return { found: false, lines: [] as Array<{ kind: string; text: string }>, note: "Bilimlar bazasi hali to'ldirilmagan" };
  const block = await loadKnowledgeBlock(profile.id, input.query);
  if (!block) return { found: false, lines: [], note: "Bilimlar bazasi topilmadi" };
  return { found: block.lines.length > 0, lines: block.lines.slice(0, 20).map((l) => ({ kind: l.kind, text: clip(l.text, 400) ?? "" })) };
}

// ─── WRITE: previews (no side effects) ────────────────────────────────────────

export interface Preview {
  summary: string;
  details: Record<string, unknown>;
  warnings: string[];
}

const KEYWORD = z.string().trim().min(1).max(60);

export const createCampaignInput = z.object({
  name: z.string().trim().min(1).max(120),
  instagramAccountId: z.string().min(1),
  keywords: z.array(KEYWORD).min(1, "Kamida bitta kalit so'z kerak").max(20),
  dmMessage: z.string().trim().min(1).max(1000),
  publicReplies: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
  publish: z.boolean().default(false),
});
export type CreateCampaignInput = z.infer<typeof createCampaignInput>;

/** Why a campaign must not go live right now (empty = fine). Reuses the account connection state. */
export async function publishBlockers(workspaceId: string, accountId: string): Promise<string[]> {
  const account = await prisma.instagramAccount.findFirst({ where: { id: accountId, workspaceId }, select: { username: true, tokenStatus: true } });
  if (!account) return [ACCOUNT_NOT_FOUND];
  if (account.tokenStatus !== "ACTIVE") return [`@${account.username} akkaunti ulanishi faol emas (${account.tokenStatus}). Yechim: Instagram'ni qayta ulang.`];
  return [];
}

async function duplicateKeywordWarnings(workspaceId: string, keywords: string[], exceptId?: string): Promise<string[]> {
  const wanted = new Set(keywords.map((k) => k.trim().toLowerCase()));
  const active = (await listCommentCampaigns(workspaceId)).filter((c) => c.active && c.id !== exceptId);
  const warnings: string[] = [];
  for (const c of active) {
    const shared = c.keywords.filter((k) => wanted.has(k.trim().toLowerCase()));
    if (shared.length > 0) warnings.push(`«${shared.join("», «")}» kalit so'zi faol "${c.name}" kampaniyasida ham bor — ikkalasi ham javob berishi mumkin.`);
  }
  return warnings;
}

function campaignSchemaInput(input: CreateCampaignInput, active: boolean) {
  return {
    name: input.name,
    instagramAccountId: input.instagramAccountId,
    triggerType: "COMMENT" as const,
    mediaScope: "ANY" as const,
    matchingMode: "CONTAINS" as const,
    keywords: input.keywords,
    publicReplyEnabled: (input.publicReplies?.length ?? 0) > 0,
    responseMessage: input.dmMessage,
    active,
  };
}

export async function previewCreateCampaign(workspaceId: string, input: CreateCampaignInput): Promise<Preview> {
  const parsed = commentCampaignSchema.safeParse(campaignSchemaInput(input, false));
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) throw notFound(ACCOUNT_NOT_FOUND);
  const warnings = await duplicateKeywordWarnings(workspaceId, parsed.data.keywords);
  if (input.publish) {
    const blockers = await publishBlockers(workspaceId, input.instagramAccountId);
    for (const b of blockers) warnings.push(`Nashr qilinmaydi, qoralama bo'lib qoladi: ${b}`);
  }
  return {
    summary: `«${input.name}» kampaniyasi yaratiladi (${input.publish ? "darhol yoqiladi" : "to'xtatilgan holatda, keyin yoqiladi"})`,
    details: {
      account: `@${account.username}`,
      keywords: parsed.data.keywords,
      commentReplies: input.publicReplies ?? [],
      dmMessage: input.dmMessage,
      willPublish: input.publish,
    },
    warnings,
  };
}

export const updateCampaignInput = z
  .object({
    campaignId: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    keywords: z.array(KEYWORD).min(1).max(20).optional(),
    dmMessage: z.string().trim().min(1).max(1000).optional(),
    publicReplies: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.keywords !== undefined || v.dmMessage !== undefined || v.publicReplies !== undefined || v.active !== undefined, {
    message: "Nimani o'zgartirish kerakligini bering: name, keywords, dmMessage, publicReplies yoki active",
  });
export type UpdateCampaignInput = z.infer<typeof updateCampaignInput>;

export const pauseCampaignInput = z.object({ campaignId: z.string().min(1) });

export async function previewUpdateCampaign(workspaceId: string, input: UpdateCampaignInput): Promise<Preview> {
  const before = await getCommentCampaign(workspaceId, input.campaignId);
  if (!before) throw notFound(CAMPAIGN_NOT_FOUND);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (input.name !== undefined) changes.name = { from: before.name, to: input.name };
  if (input.keywords !== undefined) changes.keywords = { from: before.keywords, to: input.keywords };
  if (input.dmMessage !== undefined) changes.dmMessage = { from: before.responseMessage, to: input.dmMessage };
  if (input.publicReplies !== undefined) changes.publicReplies = { from: before.replyVariants.filter((v) => v.kind === "PUBLIC").map((v) => v.text), to: input.publicReplies };
  if (input.active !== undefined) changes.status = { from: before.active ? "ACTIVE" : "PAUSED", to: input.active ? "ACTIVE" : "PAUSED" };
  const warnings: string[] = [];
  if (input.keywords) warnings.push(...(await duplicateKeywordWarnings(workspaceId, input.keywords, before.id)));
  if (input.active === true && !before.active) {
    for (const b of await publishBlockers(workspaceId, before.instagramAccountId)) warnings.push(`Yoqilmaydi: ${b}`);
  }
  return { summary: `«${before.name}» kampaniyasi o'zgartiriladi`, details: { campaignId: before.id, changes }, warnings };
}

export async function previewPauseCampaign(workspaceId: string, input: z.infer<typeof pauseCampaignInput>): Promise<Preview> {
  const campaign = await getCommentCampaign(workspaceId, input.campaignId);
  if (!campaign) throw notFound(CAMPAIGN_NOT_FOUND);
  return {
    summary: `«${campaign.name}» kampaniyasi to'xtatiladi`,
    details: { campaignId: campaign.id, from: campaign.active ? "ACTIVE" : "PAUSED", to: "PAUSED" },
    warnings: campaign.active ? [] : ["Kampaniya allaqachon to'xtatilgan"],
  };
}

export const createFlowDraftInput = z
  .object({
    instagramAccountId: z.string().min(1),
    request: z.string().trim().min(8, "So'rov juda qisqa").max(2000).optional(),
    triggerType: z.enum(FLOW_TRIGGER_TYPES).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    /** A ready graph (advanced); otherwise the AI Flow Builder writes it from `request`. */
    graph: z.unknown().optional(),
  })
  .refine((v) => v.request !== undefined || v.graph !== undefined, { message: "Oqim tavsifini (request) bering" });
export type CreateFlowDraftInput = z.infer<typeof createFlowDraftInput>;

/** What is stored with the proposal: the exact graph that was shown, so confirm saves what was previewed. */
export interface FlowDraftStored {
  instagramAccountId: string;
  name: string;
  request: string | null;
  graph: FlowGraph;
}

export async function previewCreateFlowDraft(workspaceId: string, input: CreateFlowDraftInput): Promise<{ preview: Preview; stored: FlowDraftStored }> {
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) throw notFound(ACCOUNT_NOT_FOUND);

  let graph: FlowGraph;
  let name = input.name ?? "AI oqim";
  let audit: AuditResult;
  let policy: PolicyResult;
  let extraWarnings: string[] = [];
  if (input.graph !== undefined) {
    const parsed = flowGraphDraftSchema.safeParse(input.graph);
    if (!parsed.success) throw badRequest(`Graf noto'g'ri: ${parsed.error.issues[0]?.message ?? "tuzilma"}`);
    graph = parsed.data;
    const ctx = await loadFlowContext(workspaceId, input.instagramAccountId);
    const trigger = graph.nodes.find((n) => n.type === "trigger");
    const auditCtx = auditContextFrom(ctx, trigger && trigger.type === "trigger" ? trigger.triggerType : undefined);
    audit = auditGraph(graph, auditCtx);
    policy = evaluatePolicy(graph, auditCtx);
  } else {
    const generated = await generateFlowFromPrompt(workspaceId, { request: input.request!, accountId: input.instagramAccountId, triggerType: input.triggerType });
    graph = generated.graph;
    name = input.name ?? generated.name;
    audit = generated.audit;
    policy = generated.policy;
    extraWarnings = generated.warnings;
  }
  const blocked = audit.errors.length > 0 || policy.verdict === "BLOCKED";
  const warnings = [
    ...extraWarnings,
    ...(blocked ? ["Audit/policy xatolari bor: qoralama saqlanadi, lekin nashr qilishdan oldin Flows ekranida tuzatish kerak."] : []),
    "Bu faqat QORALAMA. Nashr qilish MCP orqali mumkin emas: Flows ekranida sinab ko'ring va tasdiqlang.",
  ];
  return {
    preview: {
      summary: `«${name}» oqimi qoralama sifatida saqlanadi (manba: AI)`,
      details: { account: `@${account.username}`, graph: graphSummary(graph), ...findingsView(audit, policy) },
      warnings,
    },
    stored: { instagramAccountId: input.instagramAccountId, name, request: input.request ?? null, graph },
  };
}

export const leadTagInput = z.object({ leadId: z.string().min(1), tag: z.string().trim().min(1).max(40) });
export const leadStageInput = z.object({ leadId: z.string().min(1), stage: z.enum(LEAD_STAGES) });

async function leadCard(workspaceId: string, leadId: string) {
  const lead = await getContact(workspaceId, leadId);
  if (!lead || lead.mergedIntoId) throw notFound(LEAD_NOT_FOUND);
  return lead;
}

export async function previewLeadTag(workspaceId: string, input: z.infer<typeof leadTagInput>): Promise<Preview> {
  const lead = await leadCard(workspaceId, input.leadId);
  const existing = await findTag(workspaceId, input.tag);
  const has = existing ? lead.tags.some((t) => t.tagId === existing.id) : false;
  return {
    summary: `${lead.name ?? lead.username ?? "Lead"} ga «${input.tag}» tegi qo'shiladi`,
    details: { leadId: lead.id, lead: lead.name ?? lead.username, tag: input.tag, tagExists: Boolean(existing) },
    warnings: [...(existing ? [] : ["Bunday teg yo'q — yangi teg yaratiladi"]), ...(has ? ["Lead'da bu teg allaqachon bor"] : [])],
  };
}

export async function previewLeadStage(workspaceId: string, input: z.infer<typeof leadStageInput>): Promise<Preview> {
  const lead = await leadCard(workspaceId, input.leadId);
  return {
    summary: `${lead.name ?? lead.username ?? "Lead"} bosqichi ${lead.status} → ${input.stage} ga o'zgaradi`,
    details: { leadId: lead.id, lead: lead.name ?? lead.username, from: lead.status, to: input.stage },
    warnings: lead.status === input.stage ? ["Lead allaqachon shu bosqichda"] : [],
  };
}

// ─── WRITE: executors (only through confirm_action) ───────────────────────────

export async function executeCreateCampaign(workspaceId: string, raw: unknown) {
  const input = createCampaignInput.parse(raw);
  const parsed = commentCampaignSchema.safeParse(campaignSchemaInput(input, false));
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
  const created = unwrap(await createCommentCampaign(workspaceId, parsed.data));
  if (input.publicReplies && input.publicReplies.length > 0) {
    const variants: VariantInput[] = input.publicReplies.map((text) => ({ kind: "PUBLIC", text, weight: 1, source: "MANUAL" }));
    unwrap(await saveVariants(workspaceId, created.id, variants));
  }
  let published = false;
  const notes: string[] = [];
  if (input.publish) {
    const blockers = await publishBlockers(workspaceId, input.instagramAccountId);
    if (blockers.length === 0) published = await setCommentCampaignActive(workspaceId, created.id, true);
    else notes.push(...blockers.map((b) => `Qoralama bo'lib qoldi: ${b}`));
  }
  return { campaignId: created.id, status: published ? "ACTIVE" : "PAUSED", published, notes };
}

export async function executeUpdateCampaign(workspaceId: string, raw: unknown) {
  const input = updateCampaignInput.parse(raw);
  const before = await getCommentCampaign(workspaceId, input.campaignId);
  if (!before) throw notFound(CAMPAIGN_NOT_FOUND);
  const notes: string[] = [];

  const editsFields = input.name !== undefined || input.keywords !== undefined || input.dmMessage !== undefined || input.publicReplies !== undefined;
  if (editsFields) {
    const merged = commentCampaignSchema.safeParse({
      name: input.name ?? before.name,
      instagramAccountId: before.instagramAccountId,
      triggerType: before.triggerType,
      mediaScope: before.mediaScope,
      mediaIds: before.mediaIds,
      matchingMode: before.matchingMode,
      keywords: input.keywords ?? before.keywords,
      intents: before.intents,
      priority: before.priority,
      replyMode: before.replyMode,
      publicReplyEnabled: input.publicReplies !== undefined ? input.publicReplies.length > 0 : before.publicReplyEnabled,
      openingButtonLabel: before.openingButtonLabel,
      mainMessage: before.mainMessage,
      stopOnReply: before.stopOnReply,
      stopOnLead: before.stopOnLead,
      stopOnHandoff: before.stopOnHandoff,
      responseMessage: input.dmMessage ?? before.responseMessage,
      // Pause / resume is applied below, through the same blockers check as publishing.
      active: before.active,
    });
    if (!merged.success) throw badRequest(merged.error.issues[0]?.message ?? "Noto'g'ri ma'lumot");
    unwrap(await updateCommentCampaign(workspaceId, before.id, merged.data));
    if (input.publicReplies !== undefined) {
      const keepDm: VariantInput[] = before.replyVariants
        .filter((v) => v.kind === "DM")
        .map((v) => ({ id: v.id, kind: "DM", text: v.text, weight: v.weight, source: v.source }));
      const publics: VariantInput[] = input.publicReplies.map((text) => ({ kind: "PUBLIC", text, weight: 1, source: "MANUAL" }));
      unwrap(await saveVariants(workspaceId, before.id, [...keepDm, ...publics]));
    }
  }

  let status: "ACTIVE" | "PAUSED" = before.active ? "ACTIVE" : "PAUSED";
  if (input.active !== undefined && input.active !== before.active) {
    if (input.active) {
      const blockers = await publishBlockers(workspaceId, before.instagramAccountId);
      if (blockers.length === 0) {
        await setCommentCampaignActive(workspaceId, before.id, true);
        status = "ACTIVE";
      } else notes.push(...blockers.map((b) => `Yoqilmadi: ${b}`));
    } else {
      await setCommentCampaignActive(workspaceId, before.id, false);
      status = "PAUSED";
    }
  }
  return { campaignId: before.id, status, notes };
}

export async function executePauseCampaign(workspaceId: string, raw: unknown) {
  const input = pauseCampaignInput.parse(raw);
  const ok = await setCommentCampaignActive(workspaceId, input.campaignId, false);
  if (!ok) throw notFound(CAMPAIGN_NOT_FOUND);
  return { campaignId: input.campaignId, status: "PAUSED" as const };
}

export async function executeCreateFlowDraft(workspaceId: string, raw: unknown) {
  const stored = z
    .object({ instagramAccountId: z.string().min(1), name: z.string().min(1).max(120), request: z.string().nullable(), graph: z.unknown() })
    .parse(raw);
  const graph = flowGraphDraftSchema.safeParse(stored.graph);
  if (!graph.success) throw badRequest("Saqlangan graf buzilgan");
  const created = await createFlow(
    workspaceId,
    {
      name: stored.name,
      instagramAccountId: stored.instagramAccountId,
      graph: graph.data,
      // A prompt marks the version as AI-made: it then needs test + approval before it can be published.
      prompt: stored.request ?? "MCP orqali yaratilgan",
      changeNote: "MCP orqali yaratilgan qoralama",
    },
    { userId: null }
  );
  return {
    flowId: created.flow.id,
    status: "DRAFT" as const,
    source: "AI" as const,
    audit: { errors: created.evaluation.audit.errors.length, warnings: created.evaluation.audit.warnings.length },
    policyVerdict: created.evaluation.policy.verdict,
    note: "Nashr qilish uchun Flows ekranida sinab ko'ring va tasdiqlang.",
  };
}

export async function executeLeadTag(workspaceId: string, raw: unknown) {
  const input = leadTagInput.parse(raw);
  await leadCard(workspaceId, input.leadId);
  const tag = (await findTag(workspaceId, input.tag)) ?? (await ensureTag(workspaceId, input.tag));
  const change = await addTag(workspaceId, input.leadId, tag.id, "AI", "mcp");
  return { leadId: input.leadId, tag: change.tag.name, added: change.changed };
}

export async function executeLeadStage(workspaceId: string, raw: unknown) {
  const input = leadStageInput.parse(raw);
  const updated = unwrap(await setContactStatus(workspaceId, input.leadId, input.stage, { kind: "AI" }));
  return { leadId: input.leadId, stage: updated.status };
}
