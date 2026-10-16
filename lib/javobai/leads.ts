/**
 * Leads from JavobAI (TZ 23): the existing `createLeadForConversation` makes
 * the Lead and queues the deliveries (Telegram / CRM) exactly as production
 * does — no delivery changes. What is new sits next to it: the summary is
 * prefixed with the score band ("🔥 HOT 72") and, while the module is in the
 * developer area, with "🧪 TEST" (owner decision 3: the tenant's real
 * channels get them), and an AiLeadInsight row keeps score, temperature and
 * the extra fields. Contact memory remembers the lead across cycles.
 */

import type { Lead } from "@/app/generated/prisma/client";
import { crmTouch } from "@/lib/crm/hooks";
import { prisma } from "@/lib/db/client";
import { createLeadForConversation, readCollected, type Collected } from "@/lib/leads/service";
import { factsFromTurn, upsertContactMemory } from "./memory";
import { scoreLabel, temperatureFor, type ScoreEvent } from "./scoring";
import { ensureAiState, recordSignals, upsertConversation } from "./state";
import type { ExtractedFields } from "./turn";

export interface JavobAiLeadInput {
  conversationId: string;
  summary: string;
  flag?: "complaint" | null;
  score: number;
  thresholds: { warm: number; hot: number; veryHot: number };
  /** Signals of the current lead cycle (stored on the insight). */
  signals: ScoreEvent[];
  extracted: ExtractedFields;
  isTest: boolean;
}

/** "🧪 TEST · 🔥 HOT 72 · <summary>" */
export function leadSummaryPrefix(score: number, thresholds: JavobAiLeadInput["thresholds"], isTest: boolean): string {
  return `${isTest ? "🧪 TEST · " : ""}${scoreLabel(score, thresholds)}`;
}

/**
 * Create (idempotently, per lead cycle) the Lead of a conversation and its
 * AiLeadInsight. `Conversation.collected` must already hold the phone and
 * name — the runtime writes it before calling.
 */
export async function captureJavobAiLead(input: JavobAiLeadInput): Promise<Lead | null> {
  const summary = `${leadSummaryPrefix(input.score, input.thresholds, input.isTest)} · ${input.summary}`.slice(0, 1000);
  const lead = await createLeadForConversation(input.conversationId, { summary, flag: input.flag ?? null });
  if (!lead) return null;

  const existing = await prisma.aiLeadInsight.findUnique({ where: { leadId: lead.id }, select: { id: true } });
  if (!existing) {
    await prisma.aiLeadInsight
      .create({
        data: {
          leadId: lead.id,
          score: input.score,
          temperature: temperatureFor(input.score, input.thresholds),
          email: input.extracted.email ?? null,
          budget: input.extracted.budget ?? null,
          location: input.extracted.location ?? null,
          signals: JSON.parse(JSON.stringify(input.signals)),
          isTest: input.isTest,
        },
      })
      .catch(() => {});
  }
  // The lead's score / temperature are on the state now: mirror them into the CRM contact.
  void crmTouch({ kind: "score", conversationId: input.conversationId });

  // Contact memory (4.2): the lead id and its one-line summary survive the
  // 30-day cycle; `cycle` is what `returning` compares. Best effort.
  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: { instagramAccountId: true, igUserId: true, leadCycle: true },
  });
  if (conversation) {
    await upsertContactMemory(conversation.instagramAccountId, conversation.igUserId, {
      leadId: lead.id,
      lastSummary: input.summary,
      facts: { ...factsFromTurn({ extracted: input.extracted }), cycle: String(conversation.leadCycle) },
    }).catch(() => {});
  }
  return lead;
}

export interface TriggerLeadInput {
  account: { id: string; workspaceId: string };
  igUserId: string;
  igUsername?: string | null;
  phoneE164: string;
  phoneRaw: string;
  campaignName: string;
  /** Thresholds of the workspace's scoring config. */
  thresholds: JavobAiLeadInput["thresholds"];
  isTest: boolean;
}

/**
 * A trigger LEAD_CAPTURE chip on a LIVE account also creates a real Lead
 * (design, technical decisions): same conversation record, signal
 * `phone_provided`, summary names the campaign.
 */
export async function captureTriggerLead(input: TriggerLeadInput): Promise<Lead | null> {
  const conversation = await upsertConversation(input.account, input.igUserId);
  const state = await ensureAiState(conversation);
  const collected: Collected = {
    ...readCollected(conversation.collected),
    phone_e164: input.phoneE164,
    phone_raw: input.phoneRaw,
  };
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      collected: JSON.parse(JSON.stringify(collected)),
      igUsername: conversation.igUsername ?? input.igUsername ?? null,
      lastCustomerMessageAt: conversation.lastCustomerMessageAt ?? new Date(),
    },
  });
  const signal = { signal: "phone_provided", points: 20 };
  await recordSignals(state, [signal]);
  const events = await prisma.aiScoreEvent.findMany({
    where: { stateId: state.id, leadCycle: state.leadCycle },
    select: { signal: true, points: true },
  });
  const score = Math.max(0, Math.min(100, events.reduce((n, e) => n + e.points, 0)));
  await prisma.aiConversationState.update({
    where: { id: state.id },
    data: {
      score,
      temperature: temperatureFor(score, input.thresholds),
      context: { ...(state.context as Record<string, unknown>), campaignName: input.campaignName, source: "trigger" },
    },
  });
  return captureJavobAiLead({
    conversationId: conversation.id,
    summary: `Trigger kampaniyasi orqali raqam qoldirdi: ${input.campaignName}.`,
    score,
    thresholds: input.thresholds,
    signals: events,
    extracted: {},
    isTest: input.isTest,
  });
}
