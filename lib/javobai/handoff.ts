/**
 * Handoff lifecycle (TZ 25, design "Handoff"):
 *
 *   AI_ACTIVE ──trigger──▶ HANDOFF_PENDING   (handoff reply, alert + lead, AiHandoff OPEN)
 *   HANDOFF_PENDING ──echo / inbox reply / Telegram "Qabul qildim"──▶ OPERATOR_ACTIVE
 *   HANDOFF_PENDING ──customer writes──▶ silent (≤ postHandoffReplies grounded short replies)
 *   OPERATOR_ACTIVE ──"Yopish" (dev UI / Telegram) or inactivity N h──▶ CLOSED
 *   CLOSED ──next customer message (resumeAi)──▶ AI_ACTIVE   (memory kept)
 *
 * The state lives in AiConversationState.handoffState; every episode is an
 * AiHandoff row (OPEN → ACCEPTED → CLOSED). Production's Conversation is
 * touched only where the inbox and the hard mute need it: assistantState
 * HANDED_OFF while a handoff is open, operatorActiveUntil while the operator
 * is active. The functions are workspace-agnostic; callers scope the id.
 * Kept free of lib/meta imports (the Telegram bot loads it).
 */

import type { AiHandoffState } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { sendEmail } from "@/lib/email";
import { getBaseUrl } from "@/lib/env";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { handoffReasonLabel, type HandoffReason } from "./config";
import { upsertContactMemory } from "./memory";
import { scoreLabel } from "./scoring";
import { loadAccountConfig } from "./state";

const HOUR_MS = 60 * 60_000;
/** How long the inbox / app operator keeps the thread after accepting. */
export const OPERATOR_ACTIVE_HOURS = 24;

export interface OpenHandoffInput {
  reason: HandoffReason;
  score: number;
  thresholds: { warm: number; hot: number; veryHot: number };
  /** One line for the alert (the lead summary or the customer's last words). */
  summary?: string | null;
  /** False in SHADOW / tests: no Telegram, no email. */
  alert?: boolean;
}

async function currentState(conversationId: string) {
  return prisma.aiConversationState.findUnique({ where: { conversationId } });
}

/** The Telegram alert with the take / close buttons, plus the owner email. Best effort. */
async function alertHandoff(conversationId: string, input: OpenHandoffInput): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { workspaceId: true, igUsername: true, igName: true, igUserId: true },
  });
  if (!conversation) return;
  const who = conversation.igUsername ? `@${conversation.igUsername}` : (conversation.igName ?? conversation.igUserId);
  const label = handoffReasonLabel(input.reason);
  const score = scoreLabel(input.score, input.thresholds);
  const summary = input.summary?.trim() ? `\n${esc(input.summary.trim().slice(0, 300))}` : "";
  const html =
    `🤝 <b>JavobAI: operator kerak</b>\nSabab: ${esc(label)}\nLead: ${esc(score)}\nMijoz: ${esc(who)}${summary}\n` +
    `Qabul qilsangiz AI jim turadi; yopsangiz AI keyingi xabardan davom etadi.`;
  await notifyWorkspaceChats(conversation.workspaceId, html, {
    keyboard: [
      [
        { text: "✅ Qabul qildim", callback_data: `jai:take:${conversationId}` },
        { text: "✖ Yopish", callback_data: `jai:close:${conversationId}` },
      ],
      [{ text: "💬 Instagram suhbat", url: `${getBaseUrl()}/inbox?conversation=${conversationId}` }],
    ],
  }).catch(() => 0);
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: conversation.workspaceId },
      select: { owner: { select: { email: true } } },
    });
    const to = workspace?.owner?.email;
    if (to) {
      await sendEmail({
        to,
        subject: "JavobAI: operator kerak",
        text: `Operator kerak. Sabab: ${label}. Lead: ${score}. Mijoz: ${who}.${input.summary ? ` ${input.summary}` : ""}`,
      });
    }
  } catch {
    // Email is a secondary channel; never let it fail the turn.
  }
}

/**
 * AI_ACTIVE → HANDOFF_PENDING with an OPEN AiHandoff and the alert. A
 * conversation already pending / with an operator is left alone (a retried
 * job must not alert twice). Returns the state after the call.
 */
export async function openHandoff(conversationId: string, input: OpenHandoffInput): Promise<AiHandoffState> {
  const state = await currentState(conversationId);
  if (!state) return "AI_ACTIVE";
  if (state.handoffState === "HANDOFF_PENDING" || state.handoffState === "OPERATOR_ACTIVE") return state.handoffState;

  const open = await prisma.aiHandoff.findFirst({
    where: { conversationId, status: { in: ["OPEN", "ACCEPTED"] } },
    select: { id: true },
  });
  if (!open) {
    await prisma.aiHandoff.create({ data: { conversationId, reason: input.reason, status: "OPEN" } });
  }
  await prisma.aiConversationState.update({ where: { id: state.id }, data: { handoffState: "HANDOFF_PENDING" } });
  await prisma.conversation.update({ where: { id: conversationId }, data: { assistantState: "HANDED_OFF" } });
  if (input.alert !== false) await alertHandoff(conversationId, input).catch(() => {});
  return "HANDOFF_PENDING";
}

/** HANDOFF_PENDING (or AI_ACTIVE, when the operator just steps in) → OPERATOR_ACTIVE. */
export async function acceptHandoff(conversationId: string, by: string): Promise<AiHandoffState> {
  const state = await currentState(conversationId);
  if (!state) return "AI_ACTIVE";
  if (state.handoffState === "OPERATOR_ACTIVE") return state.handoffState;
  if (state.handoffState === "CLOSED") return state.handoffState;

  const now = new Date();
  const open = await prisma.aiHandoff.findFirst({
    where: { conversationId, status: "OPEN" },
    orderBy: { openedAt: "desc" },
    select: { id: true },
  });
  if (open) {
    await prisma.aiHandoff.update({ where: { id: open.id }, data: { status: "ACCEPTED", acceptedAt: now, acceptedBy: by } });
  } else {
    await prisma.aiHandoff.create({
      data: { conversationId, reason: "operator", status: "ACCEPTED", acceptedAt: now, acceptedBy: by },
    });
  }
  await prisma.aiConversationState.update({ where: { id: state.id }, data: { handoffState: "OPERATOR_ACTIVE" } });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { assistantState: "HANDED_OFF", operatorActiveUntil: new Date(now.getTime() + OPERATOR_ACTIVE_HOURS * HOUR_MS) },
  });
  return "OPERATOR_ACTIVE";
}

/**
 * → CLOSED. With `resumeAi` the hard mute is lifted and the next customer
 * message brings the AI back (reopenAi); without it the thread stays with
 * the humans until someone reopens it.
 */
export async function closeHandoff(conversationId: string, by: string, resumeAi = true): Promise<AiHandoffState> {
  const state = await currentState(conversationId);
  if (!state) return "AI_ACTIVE";
  const now = new Date();
  await prisma.aiHandoff.updateMany({
    where: { conversationId, status: { in: ["OPEN", "ACCEPTED"] } },
    data: { status: "CLOSED", closedAt: now, closedBy: by, resumeAi },
  });
  await prisma.aiConversationState.update({ where: { id: state.id }, data: { handoffState: "CLOSED", unknownStreak: 0 } });
  if (resumeAi) {
    await prisma.conversation.update({ where: { id: conversationId }, data: { operatorActiveUntil: null, botPaused: false } });
  }
  // The conversation's part is over: its rolling summary becomes the contact's
  // "last conversation" memory (4.2). Never fails the close.
  if (state.summary.trim()) {
    const conversation = await prisma.conversation
      .findUnique({ where: { id: conversationId }, select: { instagramAccountId: true, igUserId: true } })
      .catch(() => null);
    if (conversation) {
      await upsertContactMemory(conversation.instagramAccountId, conversation.igUserId, { lastSummary: state.summary }).catch(() => {});
    }
  }
  return "CLOSED";
}

/** CLOSED (or anything) → AI_ACTIVE: the AI answers again, memory kept. */
export async function reopenAi(conversationId: string): Promise<AiHandoffState> {
  const state = await currentState(conversationId);
  if (!state) return "AI_ACTIVE";
  await prisma.aiHandoff.updateMany({
    where: { conversationId, status: { in: ["OPEN", "ACCEPTED"] } },
    data: { status: "CLOSED", closedAt: new Date(), closedBy: "reopen", resumeAi: true },
  });
  await prisma.aiConversationState.update({ where: { id: state.id }, data: { handoffState: "AI_ACTIVE", unknownStreak: 0 } });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { assistantState: "NEED", operatorActiveUntil: null, botPaused: false },
  });
  return "AI_ACTIVE";
}

/** Whether a CLOSED conversation's AI may take the next customer message. */
export async function mayResumeAfterClose(conversationId: string): Promise<boolean> {
  const last = await prisma.aiHandoff.findFirst({
    where: { conversationId, status: "CLOSED" },
    orderBy: { openedAt: "desc" },
    select: { resumeAi: true },
  });
  return last?.resumeAi ?? true;
}

/**
 * Inactivity auto-close (design: "inactivity N h → CLOSED"): an ACCEPTED
 * handoff whose operator has not written since `resumeAfterCloseHours` of the
 * account is closed, so the AI can resume on the next customer message.
 * Runs every minute from the worker; bounded per run.
 */
export async function autoCloseInactiveHandoffs(now = new Date()): Promise<number> {
  const candidates = await prisma.aiHandoff.findMany({
    where: { status: "ACCEPTED", acceptedAt: { lt: new Date(now.getTime() - HOUR_MS) } },
    orderBy: { acceptedAt: "asc" },
    take: 100,
    select: { id: true, conversationId: true, acceptedAt: true },
  });
  let closed = 0;
  for (const handoff of candidates) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: handoff.conversationId },
      select: { instagramAccountId: true },
    });
    if (!conversation) continue;
    const config = await loadAccountConfig(conversation.instagramAccountId);
    const lastOperator = await prisma.conversationMessage.findFirst({
      where: { conversationId: handoff.conversationId, author: "OPERATOR" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const lastActivity = Math.max(handoff.acceptedAt?.getTime() ?? 0, lastOperator?.createdAt.getTime() ?? 0);
    if (now.getTime() - lastActivity < config.resumeAfterCloseHours * HOUR_MS) continue;
    await closeHandoff(handoff.conversationId, "inactivity", true);
    closed++;
  }
  return closed;
}
