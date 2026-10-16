/**
 * ETAP 10 - the ONE definition of every analytics metric.
 *
 * `computeDayMetrics(workspaceId, dayKey)` reads the source tables for one
 * Tashkent calendar day and returns the rows the rollup stores (rollup.ts).
 * Nothing else in the module defines a metric; screens read rollups only.
 *
 * Aggregation is done in memory from bounded `findMany` calls (one workspace,
 * one day) rather than `groupBy` `_sum`, the convention of lib/javobai/usage.ts,
 * so it runs against the in-memory test db too.
 *
 * Row shape: instagramAccountId "" = workspace-wide (every event is added to
 * the workspace row and to its account's row), dimKind/dimId "" = the total,
 * otherwise one slice of it (a campaign, a reason, ...). Sums and counts only.
 *
 * Exclusions: test leads (Lead.isTest / AiLeadInsight.isTest) never count;
 * every query is scoped by workspaceId.
 */

import { prisma } from "@/lib/db/client";
import { toUsd } from "@/lib/javobai/usage";
import { dayWindow } from "./time";

export interface MetricRow {
  instagramAccountId: string;
  metric: string;
  dimKind: string;
  dimId: string;
  value: number;
}

type Dim = readonly [kind: string, id: string];

class Accumulator {
  private readonly sums = new Map<string, number>();

  private bump(account: string, metric: string, kind: string, id: string, value: number) {
    const key = [account, metric, kind, id].join("\u0000");
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
  }

  /** One event: the total, plus one row per dimension slice, for the account and the workspace. */
  add(account: string | null | undefined, metric: string, value: number, dims: Dim[] = []) {
    if (!value || !Number.isFinite(value)) return;
    const accounts = account ? [account, ""] : [""];
    for (const a of accounts) {
      this.bump(a, metric, "", "", value);
      for (const [kind, id] of dims) if (kind && id) this.bump(a, metric, kind, id, value);
    }
  }

  rows(): MetricRow[] {
    const out: MetricRow[] = [];
    for (const [key, value] of this.sums) {
      if (!value) continue;
      const [instagramAccountId, metric, dimKind, dimId] = key.split("\u0000");
      out.push({ instagramAccountId, metric, dimKind, dimId, value: Math.round(value * 1_000_000) / 1_000_000 });
    }
    return out;
  }
}

interface Window {
  start: Date;
  end: Date;
  range: { gte: Date; lt: Date };
}

const inWindow = (value: Date | null | undefined, w: Window) =>
  value instanceof Date && value.getTime() >= w.start.getTime() && value.getTime() < w.end.getTime();

const SKIPPED_DM = ["SKIPPED_DEDUP", "SKIPPED_RATE_LIMIT", "SKIPPED_PLAN_LIMIT", "SKIPPED_NO_MATCH", "SKIPPED_WORKSPACE_SUSPENDED"];

function unique<T>(values: Array<T | null | undefined>): T[] {
  return [...new Set(values.filter((v): v is T => v !== null && v !== undefined && (v as unknown) !== ""))];
}

// ─── Row shapes (the fields read below) ──────────────────────────────────────

interface DmLogRow { automationId: string; instagramAccountId: string; status: string; dmSentAt: Date | null; createdAt: Date }
interface ExecRow { id: string; campaignId: string; status: string; sentAt: Date | null; createdAt: Date; openedAt: Date | null; firstInboundAt: Date | null; leadCapturedAt: Date | null }
interface CampaignRow { id: string; instagramAccountId: string }
interface FollowUpRow { executionId: string; status: string; sentAt: Date | null; scheduledAt: Date }
interface BroadcastRow { id: string; instagramAccountId: string }
interface RecipientRow { broadcastId: string; status: string; ineligibleReason: string | null; sentAt: Date | null; createdAt: Date; repliedAt: Date | null; convertedAt: Date | null }
interface ConversationRow { id: string; instagramAccountId: string; createdAt?: Date; botMessageCount?: number; aiState?: { id: string } | null }
interface LeadRow { id: string; instagramAccountId: string; conversationId: string | null; campaignId: string | null; isTest: boolean; createdAt: Date }
interface DealRow { id: string; contactId: string; pipelineId: string; leadId: string | null; assignedMemberId: string | null; createdAt: Date; wonAt: Date | null; lostAt: Date | null }
interface ContactRow { id: string; instagramAccountId: string }
interface ActivityRow { contactId: string; dealId: string | null; type: string; occurredAt: Date; payload: unknown }

async function byIds<T>(model: "conversation" | "crmContact" | "lead" | "triggerCampaign", ids: string[], where: Record<string, unknown> = {}): Promise<T[]> {
  if (ids.length === 0) return [];
  const client = prisma as unknown as Record<string, { findMany: (args: unknown) => Promise<unknown[]> }>;
  return (await client[model].findMany({ where: { ...where, id: { in: ids } } })) as T[];
}

function payloadOf(activity: ActivityRow): Record<string, unknown> {
  return activity.payload && typeof activity.payload === "object" ? (activity.payload as Record<string, unknown>) : {};
}

// ─── Campaign ────────────────────────────────────────────────────────────────

async function campaignMetrics(workspaceId: string, w: Window, acc: Accumulator) {
  const [dmCreated, dmSent, campaigns, execSent, execOther, execReplies, execLeads, broadcasts, clicks, legacyReplies] = await Promise.all([
    prisma.dmLog.findMany({ where: { workspaceId, createdAt: w.range } }),
    prisma.dmLog.findMany({
      where: { workspaceId, status: "SENT", OR: [{ dmSentAt: w.range }, { dmSentAt: null, createdAt: w.range }] },
    }),
    prisma.triggerCampaign.findMany({ where: { workspaceId } }),
    prisma.triggerExecution.findMany({
      where: { workspaceId, status: "SENT", OR: [{ sentAt: w.range }, { sentAt: null, createdAt: w.range }] },
    }),
    prisma.triggerExecution.findMany({ where: { workspaceId, status: { in: ["FAILED", "SKIPPED"] }, createdAt: w.range } }),
    prisma.triggerExecution.findMany({
      where: { workspaceId, OR: [{ firstInboundAt: w.range }, { firstInboundAt: null, openedAt: w.range }] },
    }),
    prisma.triggerExecution.findMany({ where: { workspaceId, leadCapturedAt: w.range } }),
    prisma.crmBroadcast.findMany({ where: { workspaceId } }),
    prisma.linkClick.findMany({ where: { workspaceId, createdAt: w.range } }),
    // Legacy comment campaigns: the customer's first message creates the conversation.
    prisma.conversation.findMany({ where: { workspaceId, createdAt: w.range, campaignId: { not: null } } }),
  ]);
  const campaignAccount = new Map((campaigns as unknown as CampaignRow[]).map((c) => [c.id, c.instagramAccountId]));
  const broadcastAccount = new Map((broadcasts as unknown as BroadcastRow[]).map((b) => [b.id, b.instagramAccountId]));

  // Legacy DMs (DmLog)
  for (const row of dmSent as unknown as DmLogRow[]) {
    const dims: Dim[] = [["automation", row.automationId]];
    acc.add(row.instagramAccountId, "campaign.sent", 1, dims);
    acc.add(row.instagramAccountId, "campaign.delivered", 1, dims);
    acc.add(row.instagramAccountId, "funnel.dms", 1);
  }
  for (const row of dmCreated as unknown as DmLogRow[]) {
    acc.add(row.instagramAccountId, "funnel.comments", 1);
    if (row.status === "FAILED") acc.add(row.instagramAccountId, "campaign.failed", 1, [["automation", row.automationId]]);
    else if (SKIPPED_DM.includes(row.status)) acc.add(row.instagramAccountId, "campaign.skipped", 1, [["reason", row.status]]);
  }

  // Trigger engine
  for (const row of execSent as unknown as ExecRow[]) {
    const account = campaignAccount.get(row.campaignId);
    const dims: Dim[] = [["trigger_campaign", row.campaignId]];
    acc.add(account, "campaign.sent", 1, dims);
    acc.add(account, "campaign.delivered", 1, dims);
    acc.add(account, "funnel.dms", 1);
  }
  for (const row of execOther as unknown as ExecRow[]) {
    const account = campaignAccount.get(row.campaignId);
    if (row.status === "FAILED") acc.add(account, "campaign.failed", 1, [["trigger_campaign", row.campaignId]]);
    else acc.add(account, "campaign.skipped", 1, [["reason", "TRIGGER_SKIPPED"]]);
  }
  for (const row of execReplies as unknown as ExecRow[]) {
    // firstInboundAt when known, else the moment the thread was opened.
    const at = row.firstInboundAt ?? row.openedAt;
    if (!inWindow(at, w)) continue;
    acc.add(campaignAccount.get(row.campaignId), "campaign.replies", 1, [["trigger_campaign", row.campaignId]]);
  }
  for (const row of execLeads as unknown as ExecRow[]) {
    if (!inWindow(row.leadCapturedAt, w)) continue;
    acc.add(campaignAccount.get(row.campaignId), "campaign.leads", 1, [["trigger_campaign", row.campaignId]]);
  }

  // Follow-ups
  const [followSent, followFailed] = await Promise.all([
    prisma.triggerFollowUpRun.findMany({ where: { workspaceId, status: "SENT", OR: [{ sentAt: w.range }, { sentAt: null, scheduledAt: w.range }] } }),
    prisma.triggerFollowUpRun.findMany({ where: { workspaceId, status: "FAILED", scheduledAt: w.range } }),
  ]);
  const followRows = [...(followSent as unknown as FollowUpRow[]), ...(followFailed as unknown as FollowUpRow[])];
  const execIds = unique(followRows.map((r) => r.executionId));
  const followExecs = execIds.length
    ? ((await prisma.triggerExecution.findMany({ where: { workspaceId, id: { in: execIds } } })) as unknown as ExecRow[])
    : [];
  const execCampaign = new Map(followExecs.map((e) => [e.id, e.campaignId]));
  for (const row of followRows) {
    const campaignId = execCampaign.get(row.executionId);
    const account = campaignId ? campaignAccount.get(campaignId) : undefined;
    const dims: Dim[] = campaignId ? [["trigger_campaign", campaignId]] : [];
    if (row.status === "SENT") acc.add(account, "campaign.followup_sent", 1, dims);
    else acc.add(account, "campaign.failed", 1, dims);
  }

  // Broadcasts
  const broadcastIds = [...broadcastAccount.keys()];
  if (broadcastIds.length > 0) {
    const recipients = (await prisma.crmBroadcastRecipient.findMany({
      where: {
        broadcastId: { in: broadcastIds },
        OR: [
          { sentAt: w.range },
          { repliedAt: w.range },
          { convertedAt: w.range },
          { status: { in: ["FAILED", "SKIPPED"] }, createdAt: w.range },
        ],
      },
    })) as unknown as RecipientRow[];
    for (const r of recipients) {
      const account = broadcastAccount.get(r.broadcastId);
      const dims: Dim[] = [["broadcast", r.broadcastId]];
      if (r.status === "SENT" && inWindow(r.sentAt, w)) {
        acc.add(account, "campaign.sent", 1, dims);
        acc.add(account, "campaign.delivered", 1, dims);
      }
      if (inWindow(r.repliedAt, w)) acc.add(account, "campaign.replies", 1, dims);
      if (inWindow(r.convertedAt, w)) acc.add(account, "campaign.conversions", 1, dims);
      if (r.status === "FAILED" && inWindow(r.createdAt, w)) acc.add(account, "campaign.failed", 1, dims);
      if (r.status === "SKIPPED" && inWindow(r.createdAt, w)) {
        acc.add(account, "campaign.skipped", 1, [["reason", r.ineligibleReason || "BROADCAST_SKIPPED"]]);
      }
    }
  }

  for (const click of clicks as unknown as Array<{ automationId: string; instagramAccountId: string }>) {
    acc.add(click.instagramAccountId, "campaign.clicks", 1, [["automation", click.automationId]]);
  }
  for (const conv of legacyReplies as unknown as Array<ConversationRow & { campaignId: string | null }>) {
    if (conv.campaignId) acc.add(conv.instagramAccountId, "campaign.replies", 1, [["automation", conv.campaignId]]);
  }
}

// ─── AI ──────────────────────────────────────────────────────────────────────

async function aiMetrics(workspaceId: string, w: Window, acc: Accumulator) {
  const [states, plainConversations, handoffsOpened, handoffsAccepted, insights, hotActivities, usage, shadow, events, messages] = await Promise.all([
    prisma.aiConversationState.findMany({ where: { createdAt: w.range, conversation: { workspaceId } }, include: { conversation: true } }),
    prisma.conversation.findMany({ where: { workspaceId, createdAt: w.range, botMessageCount: { gt: 0 } }, include: { aiState: true } }),
    prisma.aiHandoff.findMany({ where: { openedAt: w.range, conversation: { workspaceId } }, include: { conversation: true } }),
    prisma.aiHandoff.findMany({ where: { acceptedAt: w.range, conversation: { workspaceId } }, include: { conversation: true } }),
    prisma.aiLeadInsight.findMany({ where: { createdAt: w.range, isTest: false, lead: { workspaceId } }, include: { lead: true } }),
    prisma.crmActivity.findMany({ where: { workspaceId, type: "TEMPERATURE_CHANGED", occurredAt: w.range } }),
    prisma.llmUsage.findMany({ where: { workspaceId, createdAt: w.range } }),
    prisma.aiShadowTurn.findMany({ where: { workspaceId, createdAt: w.range } }),
    prisma.assistantEvent.findMany({ where: { workspaceId, createdAt: w.range, type: { in: ["blocked_reply", "fallback", "llm_error"] } } }),
    prisma.conversationMessage.findMany({
      where: { createdAt: w.range, author: { in: ["CUSTOMER", "ASSISTANT", "OPERATOR"] }, conversation: { workspaceId } },
      include: { conversation: true },
    }),
  ]);

  type WithConversation = { conversation: ConversationRow | null };
  for (const state of states as unknown as WithConversation[]) {
    if (state.conversation) acc.add(state.conversation.instagramAccountId, "ai.conversations", 1);
  }
  for (const conv of plainConversations as unknown as ConversationRow[]) {
    if (!conv.aiState) acc.add(conv.instagramAccountId, "assistant.conversations", 1);
  }

  // Handoffs
  for (const h of handoffsOpened as unknown as Array<WithConversation & { reason: string }>) {
    acc.add(h.conversation?.instagramAccountId, "ai.handoff", 1, [["reason", String(h.reason || "noma'lum").slice(0, 60)]]);
  }
  for (const h of handoffsAccepted as unknown as Array<WithConversation & { openedAt: Date; acceptedAt: Date | null }>) {
    const account = h.conversation?.instagramAccountId;
    acc.add(account, "ai.handoff_accepted", 1);
    if (h.acceptedAt) {
      acc.add(account, "ai.handoff_wait_ms_sum", Math.max(0, h.acceptedAt.getTime() - h.openedAt.getTime()));
      acc.add(account, "ai.handoff_wait_count", 1);
    }
  }

  // Insights: qualified, resolved (strict v1), hot fallback, lead score
  type InsightRow = { temperature: string; score: number; lead: LeadRow | null };
  const insightRows = (insights as unknown as InsightRow[]).filter((i) => i.lead && !i.lead.isTest);
  const insightConversations = unique(insightRows.map((i) => i.lead!.conversationId));
  const handedOff = new Set<string>();
  if (insightConversations.length > 0) {
    const rows = await prisma.aiHandoff.findMany({ where: { conversationId: { in: insightConversations }, openedAt: { lt: w.end } } });
    for (const r of rows as unknown as Array<{ conversationId: string }>) handedOff.add(r.conversationId);
  }
  let insightHot = 0;
  const insightHotByAccount = new Map<string, number>();
  for (const i of insightRows) {
    const account = i.lead!.instagramAccountId;
    if (i.temperature === "WARM" || i.temperature === "HOT") acc.add(account, "ai.qualified", 1);
    if (i.temperature === "HOT") {
      insightHot += 1;
      insightHotByAccount.set(account, (insightHotByAccount.get(account) ?? 0) + 1);
    }
    if (!i.lead!.conversationId || !handedOff.has(i.lead!.conversationId)) acc.add(account, "ai.resolved", 1);
    acc.add(account, "sales.score_sum", Number(i.score) || 0);
    acc.add(account, "sales.score_count", 1);
  }

  // Hot: the first time a contact turned HOT in the day; falls back to the insights when the CRM wrote nothing.
  const hot = (hotActivities as unknown as ActivityRow[]).filter((a) => payloadOf(a).to === "HOT");
  if (hot.length > 0) {
    const contacts = await byIds<ContactRow>("crmContact", unique(hot.map((a) => a.contactId)), { workspaceId });
    const accountOf = new Map(contacts.map((c) => [c.id, c.instagramAccountId]));
    const seen = new Set<string>();
    for (const a of hot) {
      if (seen.has(a.contactId)) continue;
      seen.add(a.contactId);
      acc.add(accountOf.get(a.contactId), "ai.hot", 1);
    }
  } else if (insightHot > 0) {
    for (const [account, count] of insightHotByAccount) acc.add(account, "ai.hot", count);
  }

  // LLM usage, by kind. The account comes from the conversation when the row has one.
  const usageRows = usage as unknown as Array<{ kind: string; conversationId: string | null; inputTokens: number; outputTokens: number; costUsd: unknown; latencyMs: number; ok: boolean }>;
  const eventRows = events as unknown as Array<{ type: string; conversationId: string | null }>;
  const convIds = unique([...usageRows.map((u) => u.conversationId), ...eventRows.map((e) => e.conversationId)]);
  const convs = await byIds<ConversationRow>("conversation", convIds, { workspaceId });
  const convAccount = new Map(convs.map((c) => [c.id, c.instagramAccountId]));
  for (const u of usageRows) {
    const account = u.conversationId ? convAccount.get(u.conversationId) : undefined;
    const dims: Dim[] = [["kind", u.kind || "reply"]];
    acc.add(account, "ai.calls", 1, dims);
    if (!u.ok) acc.add(account, "ai.failed_calls", 1, dims);
    acc.add(account, "ai.cost_usd", toUsd(u.costUsd), dims);
    acc.add(account, "ai.tokens_in", Number(u.inputTokens) || 0, dims);
    acc.add(account, "ai.tokens_out", Number(u.outputTokens) || 0, dims);
    acc.add(account, "ai.latency_ms_sum", Number(u.latencyMs) || 0, dims);
  }
  acc.add("", "ai.shadow_turns", (shadow as unknown[]).length);
  const EVENT_METRIC: Record<string, string> = { blocked_reply: "ai.blocked_replies", fallback: "ai.fallbacks", llm_error: "ai.llm_errors" };
  for (const e of eventRows) {
    const metric = EVENT_METRIC[e.type];
    if (metric) acc.add(e.conversationId ? convAccount.get(e.conversationId) : undefined, metric, 1);
  }

  const MESSAGE_METRIC: Record<string, string> = { CUSTOMER: "msg.customer", ASSISTANT: "msg.ai", OPERATOR: "msg.operator" };
  for (const m of messages as unknown as Array<WithConversation & { author: string }>) {
    const metric = MESSAGE_METRIC[m.author];
    if (metric) acc.add(m.conversation?.instagramAccountId, metric, 1);
  }

  await cohortMetrics(workspaceId, (states as unknown as Array<WithConversation & { conversationId: string }>), acc);
}

/**
 * AI-only vs handed-off, for the conversations the AI started this day:
 * leads they produced and deals won from them, as known at compute time (the
 * nightly trailing recompute lets late sales catch up).
 */
async function cohortMetrics(workspaceId: string, states: Array<{ conversationId: string; conversation: ConversationRow | null }>, acc: Accumulator) {
  const conversationIds = unique(states.map((s) => s.conversationId));
  if (conversationIds.length === 0) return;
  const [handoffs, leads] = await Promise.all([
    prisma.aiHandoff.findMany({ where: { conversationId: { in: conversationIds } } }),
    prisma.lead.findMany({ where: { workspaceId, conversationId: { in: conversationIds }, isTest: false } }),
  ]);
  const handedOff = new Set((handoffs as unknown as Array<{ conversationId: string }>).map((h) => h.conversationId));
  const leadRows = leads as unknown as LeadRow[];
  const leadIds = leadRows.map((l) => l.id);
  const deals = leadIds.length
    ? ((await prisma.crmDeal.findMany({ where: { workspaceId, leadId: { in: leadIds }, wonAt: { not: null } } })) as unknown as DealRow[])
    : [];
  const wonLeads = new Set(deals.map((d) => d.leadId));
  const groupOf = (conversationId: string | null) => (conversationId && handedOff.has(conversationId) ? "handed_off" : "ai_only");

  for (const s of states) acc.add(s.conversation?.instagramAccountId, `cohort.${groupOf(s.conversationId)}.conversations`, 1);
  for (const l of leadRows) {
    const group = groupOf(l.conversationId);
    acc.add(l.instagramAccountId, `cohort.${group}.leads`, 1);
    if (wonLeads.has(l.id)) acc.add(l.instagramAccountId, `cohort.${group}.won`, 1);
  }
}

// ─── Sales ───────────────────────────────────────────────────────────────────

async function salesMetrics(workspaceId: string, w: Window, acc: Accumulator) {
  const [leads, wonDeals, lostDeals, stageActivities, customerActivities, entryStages] = await Promise.all([
    prisma.lead.findMany({ where: { workspaceId, createdAt: w.range, isTest: false } }),
    prisma.crmDeal.findMany({ where: { workspaceId, wonAt: w.range } }),
    prisma.crmDeal.findMany({ where: { workspaceId, lostAt: w.range } }),
    prisma.crmActivity.findMany({ where: { workspaceId, type: "STAGE_CHANGED", occurredAt: w.range } }),
    prisma.crmActivity.findMany({ where: { workspaceId, type: "TEMPERATURE_CHANGED", occurredAt: w.range } }),
    prisma.crmStage.findMany({ where: { isEntry: true, pipeline: { workspaceId } } }),
  ]);

  const leadRows = leads as unknown as LeadRow[];
  for (const l of leadRows) {
    acc.add(l.instagramAccountId, "sales.leads", 1);
    if (l.campaignId) acc.add(l.instagramAccountId, "campaign.leads", 1, [["automation", l.campaignId]]);
  }

  // Deals -> account (via the lead, else the contact) and campaign (via the lead).
  const deals = [...(wonDeals as unknown as DealRow[]), ...(lostDeals as unknown as DealRow[])];
  const dealLeads = await byIds<LeadRow>("lead", unique(deals.map((d) => d.leadId)), { workspaceId });
  const leadById = new Map(dealLeads.map((l) => [l.id, l]));
  const activityContactIds = [...(stageActivities as unknown as ActivityRow[]), ...(customerActivities as unknown as ActivityRow[])].map((a) => a.contactId);
  const contacts = await byIds<ContactRow>("crmContact", unique([...deals.map((d) => d.contactId), ...activityContactIds]), { workspaceId });
  const contactAccount = new Map(contacts.map((c) => [c.id, c.instagramAccountId]));
  const accountOfDeal = (d: DealRow) => (d.leadId ? leadById.get(d.leadId)?.instagramAccountId : undefined) ?? contactAccount.get(d.contactId);

  const dealDims = (d: DealRow): Dim[] => [["pipeline", d.pipelineId], ["member", d.assignedMemberId ?? ""]];
  for (const d of wonDeals as unknown as DealRow[]) {
    const account = accountOfDeal(d);
    acc.add(account, "sales.won", 1, dealDims(d));
    if (d.wonAt) {
      acc.add(account, "sales.cycle_ms_sum", Math.max(0, d.wonAt.getTime() - d.createdAt.getTime()));
      acc.add(account, "sales.cycle_ms_count", 1);
    }
    const campaignId = d.leadId ? leadById.get(d.leadId)?.campaignId : null;
    if (campaignId) acc.add(account, "campaign.conversions", 1, [["automation", campaignId]]);
  }
  for (const d of lostDeals as unknown as DealRow[]) acc.add(accountOfDeal(d), "sales.lost", 1, dealDims(d));

  // Qualified: a deal left the entry stage of its pipeline (once per deal per day).
  const entryIds = new Set((entryStages as unknown as Array<{ id: string }>).map((s) => s.id));
  const qualifiedSeen = new Set<string>();
  for (const a of stageActivities as unknown as ActivityRow[]) {
    const from = payloadOf(a).fromStageId;
    if (typeof from !== "string" || !entryIds.has(from)) continue;
    const key = a.dealId ?? a.contactId;
    if (qualifiedSeen.has(key)) continue;
    qualifiedSeen.add(key);
    acc.add(contactAccount.get(a.contactId), "sales.qualified", 1);
  }

  // Customers marked by hand: turned CUSTOMER without any won deal (those count as sales).
  const customerHits = (customerActivities as unknown as ActivityRow[]).filter((a) => payloadOf(a).to === "CUSTOMER");
  if (customerHits.length > 0) {
    const contactIds = unique(customerHits.map((a) => a.contactId));
    const won = (await prisma.crmDeal.findMany({ where: { workspaceId, contactId: { in: contactIds }, wonAt: { not: null } } })) as unknown as DealRow[];
    const withSale = new Set(won.map((d) => d.contactId));
    const seen = new Set<string>();
    for (const a of customerHits) {
      if (withSale.has(a.contactId) || seen.has(a.contactId)) continue;
      seen.add(a.contactId);
      acc.add(contactAccount.get(a.contactId), "sales.customer_marked", 1);
    }
  }
}

// ─── Funnel (comments seen by SocialAuto) ────────────────────────────────────

async function commentEvents(workspaceId: string, w: Window, acc: Accumulator) {
  const events = await prisma.instagramEvent.findMany({ where: { workspaceId, eventType: "COMMENT", timestamp: w.range } });
  for (const e of events as unknown as Array<{ instagramAccountId: string }>) acc.add(e.instagramAccountId, "funnel.comments", 1);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

/** Every metric row of one workspace for one Tashkent day ("YYYY-MM-DD"). */
export async function computeDayMetrics(workspaceId: string, dayKey: string): Promise<MetricRow[]> {
  const { start, end } = dayWindow(dayKey);
  const w: Window = { start, end, range: { gte: start, lt: end } };
  const acc = new Accumulator();
  await Promise.all([
    campaignMetrics(workspaceId, w, acc),
    aiMetrics(workspaceId, w, acc),
    salesMetrics(workspaceId, w, acc),
    commentEvents(workspaceId, w, acc),
  ]);
  return acc.rows().sort((a, b) =>
    a.instagramAccountId.localeCompare(b.instagramAccountId) ||
    a.metric.localeCompare(b.metric) ||
    a.dimKind.localeCompare(b.dimKind) ||
    a.dimId.localeCompare(b.dimId)
  );
}
