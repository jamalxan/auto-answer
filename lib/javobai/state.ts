/**
 * Shared persistence helpers of the engine: the production Conversation
 * (upserted exactly like lib/assistant/engine.ts does, without importing its
 * private functions), the 1:1 AiConversationState, the per-account config and
 * the per-workspace scoring config / handoff rules. Used by runtime.ts,
 * handoff.ts, leads.ts and the AI quick-reply action.
 */

import type { AiConversationState, Conversation, InstagramAccount } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { readJavobAiConfig, type JavobAiConfig } from "./config";
import { upsertContactMemory } from "./memory";
import { readScoringConfig, type ScoringConfig } from "./scoring";
import type { ExtractedFields, HandoffRuleSnapshot } from "./turn";

const DAY_MS = 24 * 60 * 60 * 1000;
export const NEW_CONVERSATION_AFTER_MS = 30 * DAY_MS;

/**
 * Production's conversation record for (account, customer). 30+ days of
 * silence after a hand-off starts a new lead cycle (same rule as production,
 * so the lead dedup and the idempotency key keep working).
 */
export async function upsertConversation(
  account: Pick<InstagramAccount, "id" | "workspaceId">,
  igUserId: string
): Promise<Conversation> {
  const existing = await prisma.conversation.findUnique({
    where: { instagramAccountId_igUserId: { instagramAccountId: account.id, igUserId } },
  });
  if (existing) {
    const quietFor = existing.lastCustomerMessageAt ? Date.now() - existing.lastCustomerMessageAt.getTime() : 0;
    if (existing.assistantState !== "NEW" && quietFor > NEW_CONVERSATION_AFTER_MS) {
      return prisma.conversation.update({
        where: { id: existing.id },
        data: {
          assistantState: "NEW",
          botMessageCount: 0,
          phoneAskCount: 0,
          spamStreak: 0,
          operatorActiveUntil: null,
          campaignId: null,
          collected: {},
          leadCycle: { increment: 1 },
        },
      });
    }
    return existing;
  }
  try {
    return await prisma.conversation.create({
      data: { workspaceId: account.workspaceId, instagramAccountId: account.id, igUserId },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    return prisma.conversation.findUniqueOrThrow({
      where: { instagramAccountId_igUserId: { instagramAccountId: account.id, igUserId } },
    });
  }
}

/**
 * The v2 state row of a conversation, created on first use. When the
 * conversation entered a new lead cycle the score, counters and handoff
 * state start over; the old rolling summary is saved to the contact memory
 * first (4.2: "returning contact after 30 days" keeps the last recap).
 */
export async function ensureAiState(
  conversation: Pick<Conversation, "id" | "leadCycle"> & Partial<Pick<Conversation, "instagramAccountId" | "igUserId">>
): Promise<AiConversationState> {
  const existing = await prisma.aiConversationState.findUnique({ where: { conversationId: conversation.id } });
  if (!existing) {
    try {
      return await prisma.aiConversationState.create({
        data: { conversationId: conversation.id, leadCycle: conversation.leadCycle },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      return prisma.aiConversationState.findUniqueOrThrow({ where: { conversationId: conversation.id } });
    }
  }
  if (existing.leadCycle !== conversation.leadCycle) {
    if (existing.summary.trim() && conversation.instagramAccountId && conversation.igUserId) {
      await upsertContactMemory(conversation.instagramAccountId, conversation.igUserId, { lastSummary: existing.summary }).catch(() => {});
    }
    return prisma.aiConversationState.update({
      where: { id: existing.id },
      data: {
        leadCycle: conversation.leadCycle,
        handoffState: "AI_ACTIVE",
        score: 0,
        temperature: "COLD",
        unknownStreak: 0,
        turns: 0,
        extracted: {},
        summary: "",
        summaryUpToMessageId: null,
      },
    });
  }
  return existing;
}

export function readExtracted(value: unknown): ExtractedFields {
  return value && typeof value === "object" ? (value as ExtractedFields) : {};
}

export function readContext(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Signals already counted in the state's current lead cycle. */
export async function countedSignals(state: Pick<AiConversationState, "id" | "leadCycle">): Promise<string[]> {
  const rows = await prisma.aiScoreEvent.findMany({
    where: { stateId: state.id, leadCycle: state.leadCycle },
    select: { signal: true },
  });
  return rows.map((r) => r.signal);
}

/** Store the turn's new signals; a retry hitting the unique key is a no-op. */
export async function recordSignals(
  state: Pick<AiConversationState, "id" | "leadCycle">,
  signals: Array<{ signal: string; points: number }>,
  messageId?: string | null
): Promise<void> {
  for (const s of signals) {
    await prisma.aiScoreEvent
      .create({ data: { stateId: state.id, leadCycle: state.leadCycle, signal: s.signal, points: s.points, messageId: messageId ?? null } })
      .catch(() => {});
  }
}

/** The account's JavobAiAccount config with defaults (defaults when no row). */
export async function loadAccountConfig(instagramAccountId: string): Promise<JavobAiConfig> {
  const row = await prisma.javobAiAccount.findUnique({ where: { instagramAccountId }, select: { config: true } });
  return readJavobAiConfig(row?.config ?? {});
}

/** Account override first, then the workspace-wide config, then defaults. */
export async function loadScoringConfig(workspaceId: string, instagramAccountId: string): Promise<ScoringConfig> {
  const rows = await prisma.aiScoringConfig.findMany({
    where: { workspaceId, OR: [{ instagramAccountId }, { instagramAccountId: null }] },
  });
  const row = rows.find((r) => r.instagramAccountId === instagramAccountId) ?? rows.find((r) => r.instagramAccountId === null);
  return readScoringConfig(row ?? null);
}

export async function loadHandoffRules(workspaceId: string): Promise<HandoffRuleSnapshot[]> {
  const rows = await prisma.aiHandoffRule.findMany({ where: { workspaceId, active: true }, select: { kind: true, value: true } });
  return rows.map((r) => ({ kind: r.kind, value: r.value }));
}
