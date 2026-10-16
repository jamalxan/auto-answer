/**
 * ETAP 8 — materialise an `OutboundEvent`: load the subject, build the v1
 * payload (lib/integrations2/events.ts), freeze it into the event row, match
 * the active subscriptions and create one `OutboundDelivery` per matching
 * integration.
 *
 * Idempotent: a second run of the same job finds the frozen payload and
 * `materializedAt` and does nothing; a run that crashed half-way reuses the
 * frozen payload and the unique (event × integration) key keeps deliveries
 * from doubling. CRM tables are read defensively — a workspace without CRM
 * rows (or a database without the CRM tables) still gets lead payloads.
 */

import type { Integration, IntegrationSubscription, OutboundEvent } from "@/app/generated/prisma/client";
import { isUniqueViolation } from "@/lib/crm/result";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { isOutboundBusEnabled, type OutboundEventType } from "./config";
import { emitLeadHot } from "./emit";
import {
  buildPayload,
  outboundPayloadV1Schema,
  sampleEvent,
  type BuildPayloadInput,
  type InsightLike,
  type OutboundPayloadV1,
  type PayloadTemperature,
} from "./events";
import { enqueueOutboundDelivery } from "./queue";
import { matchesSubscription, readSubscriptionFilter, type SubscriptionFilter } from "./subscriptions";

export type EventLike = Pick<
  OutboundEvent,
  "id" | "workspaceId" | "type" | "subjectType" | "subjectId" | "instagramAccountId" | "isTest" | "occurredAt" | "payload"
>;

interface Hint {
  tag?: string;
  fromStageId?: string | null;
  synthetic?: boolean;
  onlyIntegrationId?: string;
}

function hintOf(payload: unknown): Hint {
  if (payload && typeof payload === "object" && "hint" in payload) {
    const hint = (payload as { hint?: unknown }).hint;
    if (hint && typeof hint === "object") return hint as Hint;
  }
  return {};
}

/** A payload frozen by an earlier run (it carries `version`), as opposed to the pre-materialise `{ hint }`. */
export function frozenPayloadOf(value: unknown): OutboundPayloadV1 | null {
  if (!value || typeof value !== "object" || !("version" in value)) return null;
  const parsed = outboundPayloadV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function safely<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// ─── Loading the subject ──────────────────────────────────────────────────────

interface Loaded {
  input: Omit<BuildPayloadInput, "type" | "eventId" | "occurredAt" | "isTest" | "workspace" | "baseUrl">;
  /** Lead of the subject, for the lead.hot rule. */
  leadId: string | null;
  leadIsTest: boolean;
  accountId: string | null;
  temperature: PayloadTemperature | null;
}

function insightLike(row: {
  score: number;
  temperature: string;
  email: string | null;
  budget: string | null;
  location: string | null;
  signals: unknown;
}): InsightLike {
  const signals = Array.isArray(row.signals)
    ? (row.signals as Array<{ signal?: unknown; points?: unknown }>)
        .filter((s) => typeof s?.signal === "string" && Number.isFinite(Number(s.points)))
        .map((s) => ({ signal: String(s.signal), points: Number(s.points) }))
    : [];
  return {
    score: row.score,
    temperature: row.temperature as PayloadTemperature,
    signals,
    email: row.email,
    budget: row.budget,
    location: row.location,
  };
}

async function contactLike(workspaceId: string, where: Record<string, unknown>) {
  const contact = await safely(() => prisma.crmContact.findFirst({ where: { workspaceId, ...where } }));
  if (!contact) return null;
  const tagRows =
    (await safely(() => prisma.crmContactTag.findMany({ where: { contactId: contact.id }, include: { tag: true } }))) ?? [];
  const tags = tagRows.map((r) => r.tag?.slug).filter((s): s is string => Boolean(s));
  let assignedMember: { id: string; name: string | null } | null = null;
  if (contact.assignedMemberId) {
    const member = await safely(() =>
      prisma.workspaceMember.findUnique({ where: { id: contact.assignedMemberId! }, include: { user: true } })
    );
    assignedMember = { id: contact.assignedMemberId, name: member?.user?.name ?? null };
  }
  return { row: contact, like: { id: contact.id, status: contact.status, source: contact.source, tags, assignedMember } };
}

async function accountLike(id: string | null | undefined) {
  if (!id) return null;
  const account = await safely(() => prisma.instagramAccount.findUnique({ where: { id }, select: { id: true, username: true } }));
  return account ? { id: account.id, username: account.username } : null;
}

async function leadParts(leadId: string, workspaceId: string) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.workspaceId !== workspaceId) return null;
  const insight = await safely(() => prisma.aiLeadInsight.findUnique({ where: { leadId: lead.id } }));
  return { lead, insight };
}

async function dealLike(dealId: string | null, where: Record<string, unknown>, fromStageId?: string | null) {
  const deal = await safely(() =>
    dealId
      ? prisma.crmDeal.findUnique({ where: { id: dealId }, include: { stage: true, pipeline: true } })
      : prisma.crmDeal.findFirst({ where, include: { stage: true, pipeline: true } })
  );
  if (!deal) return null;
  let fromStageName: string | null = null;
  if (fromStageId) {
    const from = await safely(() => prisma.crmStage.findUnique({ where: { id: fromStageId } }));
    fromStageName = from?.name ?? null;
  }
  return {
    row: deal,
    like: {
      id: deal.id,
      pipelineName: deal.pipeline?.name ?? "",
      stageName: deal.stage?.name ?? "",
      stageId: deal.stageId,
      fromStageName,
    },
  };
}

async function loadSubject(event: EventLike): Promise<Loaded | null> {
  const hint = hintOf(event.payload);
  const type = event.type as OutboundEventType;
  const workspaceId = event.workspaceId;

  if (event.subjectType === "lead") {
    const parts = await leadParts(event.subjectId, workspaceId);
    if (!parts) return null;
    const { lead, insight } = parts;
    const contact =
      (lead.conversationId ? await contactLike(workspaceId, { conversationId: lead.conversationId }) : null) ??
      (await contactLike(workspaceId, { instagramAccountId: lead.instagramAccountId, igUserId: lead.igUserId }));
    const deal = await dealLike(null, { leadId: lead.id });
    return {
      input: {
        account: await accountLike(lead.instagramAccountId),
        lead,
        insight: insight ? insightLike(insight) : null,
        contact: contact?.like ?? null,
        deal: deal?.like ?? null,
      },
      leadId: lead.id,
      leadIsTest: lead.isTest,
      accountId: lead.instagramAccountId,
      temperature: insight ? (insight.temperature as PayloadTemperature) : null,
    };
  }

  if (event.subjectType === "contact") {
    const contact = await contactLike(workspaceId, { id: event.subjectId });
    if (!contact) return null;
    const row = contact.row;
    const lead = await safely(() =>
      prisma.lead.findFirst({
        where: { workspaceId, instagramAccountId: row.instagramAccountId, igUserId: row.igUserId },
        orderBy: { createdAt: "desc" },
      })
    );
    const insight = lead ? await safely(() => prisma.aiLeadInsight.findUnique({ where: { leadId: lead.id } })) : null;
    const deal = await dealLike(null, { contactId: row.id });
    const hasScore = row.hasAiState || row.score > 0;
    void hint;
    return {
      input: {
        account: await accountLike(row.instagramAccountId),
        lead,
        insight: insight
          ? insightLike(insight)
          : hasScore
            ? { score: row.score, temperature: row.temperature as PayloadTemperature, signals: [] }
            : null,
        contact: contact.like,
        deal: deal?.like ?? null,
      },
      leadId: lead?.id ?? null,
      leadIsTest: lead?.isTest ?? false,
      accountId: row.instagramAccountId,
      temperature: null,
    };
  }

  if (event.subjectType === "deal") {
    const deal = await dealLike(event.subjectId, {}, hint.fromStageId);
    if (!deal || deal.row.workspaceId !== workspaceId) return null;
    const contact = await contactLike(workspaceId, { id: deal.row.contactId });
    const lead = deal.row.leadId
      ? await safely(() => prisma.lead.findUnique({ where: { id: deal.row.leadId! } }))
      : null;
    const insight = lead ? await safely(() => prisma.aiLeadInsight.findUnique({ where: { leadId: lead.id } })) : null;
    return {
      input: {
        account: await accountLike(contact?.row.instagramAccountId ?? lead?.instagramAccountId),
        lead,
        insight: insight ? insightLike(insight) : null,
        contact: contact?.like ?? null,
        deal: deal.like,
      },
      leadId: lead?.id ?? null,
      leadIsTest: lead?.isTest ?? false,
      accountId: contact?.row.instagramAccountId ?? lead?.instagramAccountId ?? null,
      temperature: null,
    };
  }

  if (event.subjectType === "handoff") {
    const handoff = await prisma.aiHandoff.findUnique({ where: { id: event.subjectId }, include: { conversation: true } });
    const conversation = handoff?.conversation;
    if (!handoff || !conversation || conversation.workspaceId !== workspaceId) return null;
    const state = await safely(() => prisma.aiConversationState.findFirst({ where: { conversationId: conversation.id } }));
    const lead = await safely(() =>
      prisma.lead.findFirst({ where: { conversationId: conversation.id }, orderBy: { createdAt: "desc" } })
    );
    const insight = lead ? await safely(() => prisma.aiLeadInsight.findUnique({ where: { leadId: lead.id } })) : null;
    const contact = await contactLike(workspaceId, { conversationId: conversation.id });
    return {
      input: {
        account: await accountLike(conversation.instagramAccountId),
        lead,
        insight: insight
          ? insightLike(insight)
          : state
            ? { score: state.score, temperature: state.temperature as PayloadTemperature, signals: [] }
            : null,
        contact: contact?.like ?? null,
        handoff: { id: handoff.id, reason: handoff.reason, state: state?.handoffState ?? handoff.status, openedAt: handoff.openedAt },
      },
      leadId: lead?.id ?? null,
      leadIsTest: lead?.isTest ?? false,
      accountId: conversation.instagramAccountId,
      temperature: null,
    };
  }

  if (event.subjectType === "broadcast") {
    const broadcast = await prisma.crmBroadcast.findUnique({ where: { id: event.subjectId } });
    if (!broadcast || broadcast.workspaceId !== workspaceId) return null;
    return {
      input: {
        account: await accountLike(broadcast.instagramAccountId),
        broadcast: {
          id: broadcast.id,
          name: broadcast.name,
          sent: broadcast.sentCount,
          failed: broadcast.failedCount,
          skipped: broadcast.skippedCount,
          completedAt: broadcast.completedAt ?? event.occurredAt,
        },
      },
      leadId: null,
      leadIsTest: false,
      accountId: broadcast.instagramAccountId,
      temperature: null,
    };
  }

  void type;
  return null;
}

/** The payload of `event` as the worker would freeze it now (also used by the payload preview). */
export async function buildEventPayload(event: EventLike, options: { includeTranscript?: boolean } = {}) {
  const workspace = await prisma.workspace.findUnique({ where: { id: event.workspaceId }, select: { id: true, name: true } });
  if (!workspace) return null;
  const hint = hintOf(event.payload);
  const type = event.type as OutboundEventType;

  if (hint.synthetic) {
    const account = await accountLike(event.instagramAccountId);
    const sample = sampleEvent(type, getBaseUrl());
    const payload: OutboundPayloadV1 = {
      ...sample,
      id: event.id,
      occurred_at: event.occurredAt.toISOString(),
      is_test: true,
      workspace: { id: workspace.id, name: workspace.name ?? "" },
      account: account ?? sample.account,
    };
    return { payload, leadId: null as string | null, leadIsTest: true, accountId: account?.id ?? null, temperature: null };
  }

  const loaded = await loadSubject(event);
  if (!loaded) return null;
  const payload = buildPayload({
    type,
    eventId: event.id,
    occurredAt: event.occurredAt,
    isTest: event.isTest || loaded.leadIsTest,
    workspace: { id: workspace.id, name: workspace.name ?? "" },
    baseUrl: getBaseUrl(),
    includeTranscript: options.includeTranscript,
    ...loaded.input,
  });
  return { payload, leadId: loaded.leadId, leadIsTest: loaded.leadIsTest, accountId: loaded.accountId, temperature: loaded.temperature };
}

// ─── Fan-out ──────────────────────────────────────────────────────────────────

type SubscriptionWithIntegration = IntegrationSubscription & { integration: Integration };

/** Every active subscription of this event type in the workspace (BROKEN integrations included: their deliveries are held). */
async function candidateSubscriptions(event: EventLike): Promise<SubscriptionWithIntegration[]> {
  const rows = await prisma.integrationSubscription.findMany({
    where: {
      eventType: event.type,
      active: true,
      integration: { workspaceId: event.workspaceId, status: { in: ["ACTIVE", "BROKEN"] } },
    },
    include: { integration: true },
  });
  return rows as SubscriptionWithIntegration[];
}

export interface MaterializeResult {
  skipped?: string;
  deliveries: number;
  matched?: number;
}

export async function materializeEvent(eventId: string): Promise<MaterializeResult> {
  if (!isOutboundBusEnabled()) return { skipped: "INTEGRATIONS_BUS_DISABLED", deliveries: 0 };
  const event = await prisma.outboundEvent.findUnique({ where: { id: eventId } });
  if (!event) return { skipped: "not_found", deliveries: 0 };
  if (event.materializedAt) return { skipped: "already_materialized", deliveries: 0 };
  const hint = hintOf(event.payload);

  const candidates = hint.onlyIntegrationId
    ? (await prisma.integration.findMany({ where: { id: hint.onlyIntegrationId, workspaceId: event.workspaceId } })).map(
        (integration) => ({ integration, subscription: null as IntegrationSubscription | null })
      )
    : (await candidateSubscriptions(event)).map((sub) => ({ integration: sub.integration, subscription: sub as IntegrationSubscription }));

  let payload = frozenPayloadOf(event.payload);
  let leadId: string | null = null;
  let temperature: PayloadTemperature | null = null;
  let leadIsTest = false;
  let accountId: string | null = event.instagramAccountId;

  if (!payload) {
    const includeTranscript = candidates.some((c) => c.subscription && readSubscriptionFilter(c.subscription.filter).include_transcript);
    const built = await buildEventPayload(event, { includeTranscript });
    if (!built) {
      await prisma.outboundEvent.update({ where: { id: event.id }, data: { materializedAt: new Date(), payload: undefined } });
      return { skipped: "subject_missing", deliveries: 0 };
    }
    payload = built.payload;
    leadId = built.leadId;
    temperature = built.temperature;
    leadIsTest = built.leadIsTest;
    accountId = built.accountId ?? accountId;
    await prisma.outboundEvent.update({
      where: { id: event.id },
      data: { payload: JSON.parse(JSON.stringify(payload)), isTest: payload.is_test },
    });
  }

  let created = 0;
  let matched = 0;
  const now = new Date();
  for (const { integration, subscription } of candidates) {
    const filter: SubscriptionFilter = subscription ? readSubscriptionFilter(subscription.filter) : { v: 1, include_test: true };
    if (!matchesSubscription(filter, payload)) continue;
    // The integration's own Instagram-account filter (same field the lead pipeline uses).
    if (integration.igAccountFilter.length > 0 && accountId && !integration.igAccountFilter.includes(accountId)) continue;
    matched++;
    try {
      const delivery = await prisma.outboundDelivery.create({
        data: {
          eventId: event.id,
          integrationId: integration.id,
          subscriptionId: subscription?.id ?? null,
          status: "PENDING",
          nextAttemptAt: integration.status === "ACTIVE" ? now : null,
        },
      });
      created++;
      if (integration.status === "ACTIVE") await enqueueOutboundDelivery(delivery.id, 0, 0);
    } catch (error) {
      if (!isUniqueViolation(error) && !(error instanceof Error && /Unique constraint/i.test(error.message))) throw error;
    }
  }

  await prisma.outboundEvent.update({ where: { id: event.id }, data: { materializedAt: new Date() } });

  // lead.hot rule: a lead that is HOT from its first moment also fires lead.hot (once per lead).
  if (event.type === "lead.created" && leadId && temperature === "HOT") {
    await emitLeadHot({
      id: leadId,
      workspaceId: event.workspaceId,
      instagramAccountId: accountId ?? "",
      isTest: leadIsTest,
    });
  }
  return { deliveries: created, matched };
}

/** The frozen payload as one subscription wants it: no transcript unless it asked for one. */
export function payloadForSubscription(payload: OutboundPayloadV1, filter: SubscriptionFilter): OutboundPayloadV1 {
  if (filter.include_transcript || payload.transcript === undefined) return payload;
  const copy = { ...payload };
  delete copy.transcript;
  return copy;
}
