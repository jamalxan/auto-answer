/**
 * ETAP 5.0 — the merged contact timeline (TZ 32, design 4a).
 *
 * Nothing is copied: every page reads the stores live by their indexed keys
 * and merges them with lib/crm/timeline-merge.ts:
 *
 *   ConversationMessage   by conversationId (assistant / JavobAI / operator)
 *   TriggerMessage        by the trigger conversation of instagramContactId
 *   TriggerExecution      comment replies of the person's events
 *   TriggerFollowUpRun    follow-ups sent for those executions
 *   InstagramEvent        comments / DMs by (instagramAccountId, senderId)
 *   DmLog                 legacy comment → DM campaigns by (account, commenterId)
 *   Lead + LeadDelivery   by conversationId / (workspace, account, igUserId)
 *   AiHandoff, AiScoreEvent  by conversationId
 *   CrmActivity           by contactId (tags, stages, assignments, notes, ...)
 *
 * Keyset paging: each store gives its `limit` newest items older than
 * `before`; the merge of those is exact for the page. The same Instagram
 * message in two stores (same mid) is shown once.
 */

import { prisma } from "@/lib/db/client";
import { mergeTimeline, pageByTime, type TimelineItem, type TimelinePage } from "./timeline-merge";
import { ACTIVITY_TYPE_LABELS } from "./types";

export interface TimelineOptions {
  before?: Date | null;
  limit?: number;
}

export const TIMELINE_PAGE_LIMIT = 50;

/** Stores the feed reads live; CrmActivity rows synced from them are skipped to avoid doubles. */
const LIVE_SOURCE_TABLES = ["Lead", "LeadDelivery", "AiHandoff"];

const INTEGRATION_LABELS: Record<string, string> = {
  TELEGRAM: "Telegram",
  AMOCRM: "amoCRM",
  BITRIX24: "Bitrix24",
  GOOGLE_SHEETS: "Google Sheets",
  WEBHOOK: "Webhook",
};

function olderThan(column: string, before: Date | null | undefined) {
  return before ? { [column]: { lt: before } } : {};
}

export async function loadTimeline(workspaceId: string, contactId: string, options: TimelineOptions = {}): Promise<TimelinePage> {
  const limit = Math.min(Math.max(options.limit ?? TIMELINE_PAGE_LIMIT, 1), 200);
  const before = options.before ?? null;
  const contact = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId } });
  if (!contact) return { items: [], nextBefore: null, hasMore: false };

  const sources = await Promise.all([
    conversationMessages(contact.conversationId, before, limit),
    triggerMessages(contact.instagramContactId, before, limit),
    triggerExecutions(contact.instagramAccountId, contact.igUserId, before, limit),
    instagramEvents(contact.instagramAccountId, contact.igUserId, before, limit),
    dmLogs(contact.instagramAccountId, contact.igUserId, before, limit),
    leads(contact, before, limit),
    handoffs(contact.conversationId, before, limit),
    scoreEvents(contact.conversationId, before, limit),
    activities(contact.id, before, limit),
  ]);
  return pageByTime(mergeTimeline(sources, { dedupeByMid: true }), before, limit);
}

// ─── Per-store readers ────────────────────────────────────────────────────────

async function conversationMessages(conversationId: string | null, before: Date | null, limit: number): Promise<TimelineItem[]> {
  if (!conversationId) return [];
  const rows = await prisma.conversationMessage.findMany({
    where: { conversationId, ...olderThan("createdAt", before) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((m) => {
    const meta = (m.llmMeta ?? null) as Record<string, unknown> | null;
    const base = { id: `cm_${m.id}`, occurredAt: m.createdAt, body: m.text, mid: m.mid, sourceTable: "ConversationMessage" as const, sourceId: m.id, payload: meta };
    switch (m.author) {
      case "CUSTOMER":
        return { ...base, type: "INBOUND_MESSAGE" as const, actorKind: "CUSTOMER" as const, title: ACTIVITY_TYPE_LABELS.INBOUND_MESSAGE };
      case "ASSISTANT":
        return { ...base, type: "AI_REPLY" as const, actorKind: "AI" as const, title: ACTIVITY_TYPE_LABELS.AI_REPLY };
      case "OPERATOR":
        return { ...base, type: "OPERATOR_REPLY" as const, actorKind: "OPERATOR" as const, title: ACTIVITY_TYPE_LABELS.OPERATOR_REPLY };
      default:
        return { ...base, type: "AUTOMATION_REPLY" as const, actorKind: "SYSTEM" as const, title: "Tizim xabari" };
    }
  });
}

async function triggerMessages(instagramContactId: string | null, before: Date | null, limit: number): Promise<TimelineItem[]> {
  if (!instagramContactId) return [];
  const conversation = await prisma.triggerConversation.findUnique({ where: { contactId: instagramContactId }, select: { id: true } });
  if (!conversation) return [];
  const rows = await prisma.triggerMessage.findMany({
    where: { conversationId: conversation.id, ...olderThan("createdAt", before) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((m) => {
    const isComment = m.eventType === "COMMENT" || m.eventType === "LIVE_COMMENT";
    const inbound = m.direction === "INBOUND";
    return {
      id: `tm_${m.id}`,
      type: inbound ? (isComment ? "COMMENT" : "INBOUND_MESSAGE") : m.executionId ? "AUTOMATION_REPLY" : "AUTOMATION_REPLY",
      occurredAt: m.createdAt,
      actorKind: inbound ? "CUSTOMER" : "AUTOMATION",
      title: inbound ? (isComment ? ACTIVITY_TYPE_LABELS.COMMENT : ACTIVITY_TYPE_LABELS.INBOUND_MESSAGE) : ACTIVITY_TYPE_LABELS.AUTOMATION_REPLY,
      body: m.text,
      mid: m.mid,
      sourceTable: "TriggerMessage",
      sourceId: m.id,
      payload: { eventType: m.eventType, storyId: m.storyId, eventId: m.eventId, executionId: m.executionId },
    };
  });
}

async function triggerExecutions(instagramAccountId: string, igUserId: string, before: Date | null, limit: number): Promise<TimelineItem[]> {
  const rows = await prisma.triggerExecution.findMany({
    where: {
      status: "SENT",
      sentAt: { not: null, ...(before ? { lt: before } : {}) },
      event: { instagramAccountId, senderId: igUserId },
    },
    orderBy: { sentAt: "desc" },
    take: limit,
    include: {
      campaign: { select: { name: true } },
      event: { select: { eventType: true } },
      followUps: { where: { status: "SENT" }, select: { id: true, sentAt: true, stepId: true } },
    },
  });
  const items: TimelineItem[] = [];
  for (const e of rows) {
    const isComment = e.event.eventType === "COMMENT" || e.event.eventType === "LIVE_COMMENT";
    items.push({
      id: `te_${e.id}`,
      type: isComment ? "COMMENT_REPLY" : "AUTOMATION_REPLY",
      occurredAt: e.sentAt!,
      actorKind: "AUTOMATION",
      title: isComment ? ACTIVITY_TYPE_LABELS.COMMENT_REPLY : ACTIVITY_TYPE_LABELS.AUTOMATION_REPLY,
      body: e.responseText,
      mid: e.sentMessageId,
      sourceTable: "TriggerExecution",
      sourceId: e.id,
      payload: { campaignName: e.campaign.name, campaignId: e.campaignId, matchedKeyword: e.matchedKeyword, publicReplyStatus: e.publicReplyStatus },
    });
    for (const run of e.followUps) {
      if (!run.sentAt || (before && run.sentAt >= before)) continue;
      items.push({
        id: `tfr_${run.id}`,
        type: "FOLLOW_UP_SENT",
        occurredAt: run.sentAt,
        actorKind: "AUTOMATION",
        title: ACTIVITY_TYPE_LABELS.FOLLOW_UP_SENT,
        sourceTable: "TriggerFollowUpRun",
        sourceId: run.id,
        payload: { campaignName: e.campaign.name, executionId: e.id, stepId: run.stepId },
      });
    }
  }
  return items;
}

async function instagramEvents(instagramAccountId: string, igUserId: string, before: Date | null, limit: number): Promise<TimelineItem[]> {
  const rows = await prisma.instagramEvent.findMany({
    where: {
      instagramAccountId,
      senderId: igUserId,
      eventType: { in: ["COMMENT", "LIVE_COMMENT", "DIRECT_MESSAGE", "STORY_REPLY", "STORY_MENTION"] },
      ...olderThan("timestamp", before),
    },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
  return rows.map((e) => {
    const isComment = e.eventType === "COMMENT" || e.eventType === "LIVE_COMMENT";
    const title =
      e.eventType === "STORY_REPLY" ? "Story'ga javob" : e.eventType === "STORY_MENTION" ? "Story'da belgiladi" : isComment ? ACTIVITY_TYPE_LABELS.COMMENT : ACTIVITY_TYPE_LABELS.INBOUND_MESSAGE;
    return {
      id: `ev_${e.id}`,
      type: isComment ? "COMMENT" : "INBOUND_MESSAGE",
      occurredAt: e.timestamp,
      actorKind: "CUSTOMER",
      title,
      body: e.text || null,
      mid: e.messageId,
      sourceTable: "InstagramEvent",
      sourceId: e.id,
      payload: { eventType: e.eventType, mediaId: e.mediaId, storyId: e.storyId, referralSource: e.referralSource, ref: e.ref, payload: e.payload },
    };
  });
}

async function dmLogs(instagramAccountId: string, igUserId: string, before: Date | null, limit: number): Promise<TimelineItem[]> {
  const rows = await prisma.dmLog.findMany({
    where: { instagramAccountId, commenterId: igUserId, ...olderThan("createdAt", before) },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { automation: { select: { name: true } } },
  });
  const items: TimelineItem[] = [];
  for (const log of rows) {
    items.push({
      id: `dmc_${log.id}`,
      type: "COMMENT",
      occurredAt: log.createdAt,
      actorKind: "CUSTOMER",
      title: ACTIVITY_TYPE_LABELS.COMMENT,
      body: log.commentText,
      mid: log.commentId,
      sourceTable: "DmLog",
      sourceId: `${log.id}:comment`,
      payload: { campaignName: log.automation.name, matchedKeyword: log.matchedKeyword },
    });
    if (log.status === "SENT" && log.dmSentAt && (!before || log.dmSentAt < before)) {
      items.push({
        id: `dm_${log.id}`,
        type: "AUTOMATION_REPLY",
        occurredAt: log.dmSentAt,
        actorKind: "AUTOMATION",
        title: `Kampaniya DM: ${log.automation.name}`,
        sourceTable: "DmLog",
        sourceId: log.id,
        payload: { campaignName: log.automation.name, automationId: log.automationId },
      });
    }
  }
  return items;
}

async function leads(
  contact: { workspaceId: string; instagramAccountId: string; igUserId: string; conversationId: string | null },
  before: Date | null,
  limit: number
): Promise<TimelineItem[]> {
  const rows = await prisma.lead.findMany({
    where: {
      workspaceId: contact.workspaceId,
      isTest: false,
      OR: [
        ...(contact.conversationId ? [{ conversationId: contact.conversationId }] : []),
        { instagramAccountId: contact.instagramAccountId, igUserId: contact.igUserId },
      ],
      ...olderThan("createdAt", before),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { deliveries: { include: { integration: { select: { type: true, name: true } } } } },
  });
  const items: TimelineItem[] = [];
  for (const lead of rows) {
    items.push({
      id: `lead_${lead.id}`,
      type: "LEAD_CREATED",
      occurredAt: lead.createdAt,
      actorKind: "SYSTEM",
      title: lead.isRepeat ? "Takroriy lead yaratildi" : ACTIVITY_TYPE_LABELS.LEAD_CREATED,
      body: lead.summary,
      sourceTable: "Lead",
      sourceId: lead.id,
      payload: { leadId: lead.id, source: lead.source, campaignName: lead.campaignName, productInterest: lead.productInterest, flag: lead.flag, contactedAt: lead.contactedAt },
    });
    for (const d of lead.deliveries) {
      if (d.status !== "SENT" || !d.sentAt || (before && d.sentAt >= before)) continue;
      const label = INTEGRATION_LABELS[d.integration.type] ?? d.integration.name;
      items.push({
        id: `ld_${d.id}`,
        type: "LEAD_DELIVERED",
        occurredAt: d.sentAt,
        actorKind: "SYSTEM",
        title: `${ACTIVITY_TYPE_LABELS.LEAD_DELIVERED}: ${label}`,
        sourceTable: "LeadDelivery",
        sourceId: d.id,
        payload: { leadId: lead.id, integrationType: d.integration.type, kind: d.kind, externalUrl: d.externalUrl },
      });
    }
  }
  return items;
}

async function handoffs(conversationId: string | null, before: Date | null, limit: number): Promise<TimelineItem[]> {
  if (!conversationId) return [];
  const rows = await prisma.aiHandoff.findMany({
    where: { conversationId, ...olderThan("openedAt", before) },
    orderBy: { openedAt: "desc" },
    take: limit,
  });
  const items: TimelineItem[] = [];
  for (const h of rows) {
    items.push({
      id: `ho_${h.id}`,
      type: "HANDOFF_OPENED",
      occurredAt: h.openedAt,
      actorKind: "AI",
      title: ACTIVITY_TYPE_LABELS.HANDOFF_OPENED,
      body: h.reason,
      sourceTable: "AiHandoff",
      sourceId: `${h.id}:opened`,
      payload: { handoffId: h.id, reason: h.reason },
    });
    if (h.acceptedAt && (!before || h.acceptedAt < before)) {
      items.push({
        id: `ha_${h.id}`,
        type: "HANDOFF_ACCEPTED",
        occurredAt: h.acceptedAt,
        actorKind: "OPERATOR",
        title: ACTIVITY_TYPE_LABELS.HANDOFF_ACCEPTED,
        body: h.acceptedBy,
        sourceTable: "AiHandoff",
        sourceId: `${h.id}:accepted`,
        payload: { handoffId: h.id, acceptedBy: h.acceptedBy },
      });
    }
    if (h.closedAt && (!before || h.closedAt < before)) {
      items.push({
        id: `hc_${h.id}`,
        type: "HANDOFF_CLOSED",
        occurredAt: h.closedAt,
        actorKind: h.closedBy === "inactivity" || h.closedBy === "reopen" ? "SYSTEM" : "OPERATOR",
        title: ACTIVITY_TYPE_LABELS.HANDOFF_CLOSED,
        body: h.closedBy,
        sourceTable: "AiHandoff",
        sourceId: `${h.id}:closed`,
        payload: { handoffId: h.id, closedBy: h.closedBy, resumeAi: h.resumeAi },
      });
    }
  }
  return items;
}

async function scoreEvents(conversationId: string | null, before: Date | null, limit: number): Promise<TimelineItem[]> {
  if (!conversationId) return [];
  const state = await prisma.aiConversationState.findUnique({ where: { conversationId }, select: { id: true } });
  if (!state) return [];
  const rows = await prisma.aiScoreEvent.findMany({
    where: { stateId: state.id, ...olderThan("createdAt", before) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((s) => ({
    id: `se_${s.id}`,
    type: "SCORE_CHANGED",
    occurredAt: s.createdAt,
    actorKind: "AI",
    title: `Ball ${s.points >= 0 ? "+" : ""}${s.points}: ${s.signal}`,
    sourceTable: "AiScoreEvent",
    sourceId: s.id,
    payload: { signal: s.signal, points: s.points, leadCycle: s.leadCycle },
  }));
}

async function activities(contactId: string, before: Date | null, limit: number): Promise<TimelineItem[]> {
  const rows = await prisma.crmActivity.findMany({
    where: {
      contactId,
      OR: [{ sourceTable: null }, { sourceTable: { notIn: LIVE_SOURCE_TABLES } }],
      ...olderThan("occurredAt", before),
    },
    orderBy: { occurredAt: "desc" },
    take: limit,
  });
  return rows.map((a) => ({
    id: `act_${a.id}`,
    type: a.type,
    occurredAt: a.occurredAt,
    actorKind: a.actorKind,
    title: a.title,
    body: a.body,
    sourceTable: "CrmActivity",
    sourceId: a.id,
    payload: { ...((a.payload ?? {}) as Record<string, unknown>), dealId: a.dealId, actorMemberId: a.actorMemberId },
  }));
}
