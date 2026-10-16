/**
 * DIRECT_MESSAGE handler — the conversation after a Comment 2.0 private reply.
 *
 *   c2:<execution>:open        button tap  → window opened, main message with
 *                                            quick replies, follow-ups scheduled
 *   c2:<execution>:qr:<id>     quick reply → MESSAGE / LEAD_CAPTURE / HANDOFF
 *   plain DM from someone with an ACTIVE execution (comment, live comment or
 *   DM trigger; claim.ts findActiveConversations: < 24h since its last
 *   activity, not stopped)                 → lastInboundAt (keeps the 24h window
 *                                            open); stop-on-reply cancels follow-ups.
 *                                            A stale execution is never revived.
 *   then, for a plain DM, the DM-side triggers (ETAP 3, dm-trigger-handler.ts
 *   passes them in as `onPlainMessage`): they answer only with the campaign
 *   the webhook claimed the event for. While a comment / live campaign owns
 *   the thread the webhook claims nothing (two bots must not talk to the
 *   person at once), so the message only counts as the reply to that flow
 *   anything else                          → IGNORED
 *
 * Taps work the same for every execution, whatever started it: a DM-trigger
 * reply carries the same "c2:<execution>:qr:<id>" chips as a main message.
 *
 * Every send checks Meta's 24-hour window first (the tap or message that
 * opened it, minus a safety margin) and is skipped with a reason when closed.
 *
 * Idempotent per event: right before the send an OUTBOUND marker message
 * (mid "pending:<event>:<kind>") is stored, and replaced by Meta's mid once
 * the send succeeds. A retried job re-runs the bookkeeping (timestamps,
 * follow-ups — all idempotent) but never re-sends: a confirmed message means
 * "sent", a leftover marker means the previous run died mid-send — Instagram
 * may have delivered it, and a second DM is worse than none (the same rule as
 * an execution left in SENDING). A clean failure from Meta removes the marker
 * so the retry can send.
 *
 * The main message and its quick replies go out on the first tap only; a
 * later tap on the same button just keeps the window open.
 *
 * Phone quick replies: Instagram fills in the number and sends it as the
 * message text. If it comes back without our "c2:" payload (Meta may put the
 * number there instead), a phone number from someone with a pending lead
 * (lead-capture.ts — the same rule the webhook route uses to claim the
 * message) is treated as that tap.
 */

import { prisma } from "@/lib/db/client";
import { sendDirectMessage, sendDirectMessageWithQuickReplies, type QuickReplyOption } from "@/lib/meta/client";
import { parsePhone, type ParsedPhone } from "@/lib/leads/phone";
import { getJavobAiMode } from "@/lib/javobai/gate";
import { captureTriggerLead } from "@/lib/javobai/leads";
import { handJavobAiThread } from "@/lib/javobai/runtime";
import { loadAccountConfig, loadScoringConfig } from "@/lib/javobai/state";
import { handleFlowInbound, handleFlowTap } from "@/lib/flows/bridge";
import { isFlowPayload } from "@/lib/flows/config";
import { alertWorkspace } from "@/lib/telegram/notify";
import type { TriggerCampaign, TriggerExecution, TriggerQuickReply } from "@/app/generated/prisma/client";
import { COMMENT_OWNS_THREAD_REASON, CONVERSATION_EVENT_TYPES, findActiveConversations } from "./claim";
import { recordInteraction, type RecordedInteraction } from "./contacts";
import { eventFailure, readAccessToken, sendGuarded, type EventWithAccount, type HandlerResult } from "./delivery";
import { cancelFollowUps, isWindowOpen, scheduleFollowUps, WINDOW_CLOSED_REASON } from "./followups";
import { isUniqueViolation } from "./ingest";
import { findPendingLeadExecution, phoneFromText, STOP_ON_REPLY_REASON } from "./lead-capture";
import { C2_PAYLOAD_PREFIX } from "./normalize";

export const DEFAULT_LEAD_THANKS = "Rahmat! Raqamingizni oldik, tez orada siz bilan bog'lanamiz.";
export const DEFAULT_HANDOFF_REPLY = "Rahmat! Operatorimiz tez orada sizga javob beradi.";
/** Follow-ups are cancelled with this reason when the thread goes to JavobAI (action AI). */
export const AI_HANDOFF_REASON = "JavobAI'ga o'tkazildi";
const INTERRUPTED_REASON =
  "Oldingi urinishda yuborish jarayoni uzildi — ikki marta yubormaslik uchun qayta yuborilmadi.";
const PENDING_MID_PREFIX = "pending:";
export { COMMENT_OWNS_THREAD_REASON };

// ─── Payload ──────────────────────────────────────────────────────────────────

export type C2Action =
  | { executionId: string; action: "open" }
  | { executionId: string; action: "qr"; quickReplyId: string };

/** "c2:<executionId>:open" / "c2:<executionId>:qr:<quickReplyId>" → parts; null for anything else. */
export function parseC2Payload(payload: string | null | undefined): C2Action | null {
  if (!payload || !payload.startsWith(C2_PAYLOAD_PREFIX)) return null;
  const parts = payload.slice(C2_PAYLOAD_PREFIX.length).split(":");
  const [executionId, action, quickReplyId] = parts;
  if (!executionId) return null;
  if (action === "open" && parts.length === 2) return { executionId, action: "open" };
  if (action === "qr" && quickReplyId && parts.length === 3) return { executionId, action: "qr", quickReplyId };
  return null;
}

export function quickReplyPayload(executionId: string, quickReplyId: string): string {
  return `c2:${executionId}:qr:${quickReplyId}`;
}

/** The chips under the main message. LEAD_CAPTURE asks Instagram for the phone number. */
export function buildQuickReplies(executionId: string, quickReplies: TriggerQuickReply[]): QuickReplyOption[] {
  return [...quickReplies]
    .sort((a, b) => a.sort - b.sort || a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, 13)
    .map((qr) => ({
      title: qr.label.slice(0, 20),
      payload: quickReplyPayload(executionId, qr.id),
      contentType: qr.action === "LEAD_CAPTURE" ? ("user_phone_number" as const) : ("text" as const),
    }));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Sending inside the window ────────────────────────────────────────────────

type ExecutionWithCampaign = TriggerExecution & { campaign: TriggerCampaign };

interface Ctx {
  event: EventWithAccount;
  interaction: RecordedInteraction;
  execution: ExecutionWithCampaign;
  now: Date;
  /** Set when a reply was not re-sent after an interrupted run; shown in the logs. */
  warning?: string;
}

/**
 * One reply for this event, at most once: skipped when the window is closed
 * or a reply (or the marker of an interrupted send) for this event is already
 * stored. `kind` names the reply in the marker. Returns a HandlerResult only
 * when the event must end with it (failure / retry).
 */
async function replyOnce(
  ctx: Ctx,
  kind: string,
  text: string,
  quickReplies: QuickReplyOption[] = []
): Promise<HandlerResult | null> {
  const { event, execution } = ctx;
  if (!text.trim()) return null;
  const conversationId = ctx.interaction.conversation.id;

  const already = await prisma.triggerMessage.findFirst({
    where: { eventId: event.id, direction: "OUTBOUND" },
    select: { mid: true },
  });
  if (already) {
    if (already.mid?.startsWith(PENDING_MID_PREFIX)) {
      console.warn(`[Trigger Engine] ${event.id}: interrupted send found, not sending again`);
      ctx.warning = INTERRUPTED_REASON;
    }
    return null;
  }

  if (!isWindowOpen(execution, ctx.now)) {
    console.log(`[Trigger Engine] ${event.id}: ${WINDOW_CLOSED_REASON}`);
    return { status: "PROCESSED", error: WINDOW_CLOSED_REASON };
  }

  const account = event.instagramAccount;
  const token = readAccessToken(account);
  if (!token.ok) return eventFailure(event, token.failure);

  const pendingMid = `${PENDING_MID_PREFIX}${event.id}:${kind}`;
  let markerId: string | null = null;
  const result = await sendGuarded(
    event.workspaceId,
    account,
    () =>
      quickReplies.length > 0
        ? sendDirectMessageWithQuickReplies(token.token, account.instagramId, event.senderId, text, quickReplies)
        : sendDirectMessage(token.token, account.instagramId, event.senderId, text),
    {
      // Written before the send: if anything dies between the send and the
      // bookkeeping, the retry finds it and does not send twice.
      beforeSend: async () => {
        try {
          const marker = await prisma.triggerMessage.create({
            data: {
              conversationId,
              direction: "OUTBOUND",
              text,
              mid: pendingMid,
              eventId: event.id,
              executionId: execution.id,
            },
            select: { id: true },
          });
          markerId = marker.id;
        } catch (error) {
          // Another run got here first: that one sends.
          if (isUniqueViolation(error)) throw new Error(`Reply for event ${event.id} is already being sent`);
          throw error;
        }
      },
    }
  );
  if (!result.ok) {
    // Meta refused the send (sendGuarded caught it): nothing went out, so the
    // retry may send. A timeout after delivery is the one case this cannot
    // tell apart (see README).
    if (markerId) await prisma.triggerMessage.delete({ where: { id: markerId } }).catch(() => {});
    if (result.skipped) return { status: "PROCESSED", error: result.error, errorDetail: result.errorDetail };
    return eventFailure(event, result.failure);
  }

  if (markerId) {
    await prisma.triggerMessage
      .update({
        where: { id: markerId },
        data: { mid: result.sent.message_id ?? `sent:${event.id}:${kind}` },
      })
      .catch((error) => {
        // The marker stays: a retry will not re-send, which is what we want.
        console.error("[Trigger Engine] outbound message not confirmed:", error instanceof Error ? error.message : error);
      });
  }
  return null;
}

/** lastInboundAt only moves forward (a late retry never rewinds it). */
async function touchInbound(
  execution: ExecutionWithCampaign,
  at: Date,
  extra: Partial<Pick<TriggerExecution, "openedAt" | "leadCapturedAt" | "handedOffAt">> = {}
) {
  const lastInboundAt =
    execution.lastInboundAt && execution.lastInboundAt.getTime() > at.getTime() ? execution.lastInboundAt : at;
  // The first message from the person is kept for analytics (replies); set once.
  const data = { lastInboundAt, ...(execution.firstInboundAt ? {} : { firstInboundAt: at }), ...extra };
  await prisma.triggerExecution.update({ where: { id: execution.id }, data });
  Object.assign(execution, data);
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function handleOpen(ctx: Ctx): Promise<HandlerResult> {
  const { execution, event } = ctx;
  const campaign = execution.campaign;
  if (execution.handedOffAt) {
    await touchInbound(execution, event.timestamp);
    return { status: "PROCESSED", error: "Suhbat operatorga o'tkazilgan — avtomatik xabar yuborilmadi." };
  }

  const firstOpen = !execution.openedAt;
  await touchInbound(execution, event.timestamp, firstOpen ? { openedAt: event.timestamp } : {});
  // This event opened the window (now, or on an earlier try of the same event).
  const openingTap = execution.openedAt?.getTime() === event.timestamp.getTime();

  // A later tap on the same button only keeps the window open: the main
  // message and its chips are already in the thread, and repeating them on
  // every tap would read as spam.
  if (openingTap && campaign.mainMessage?.trim()) {
    const quickReplies = await prisma.triggerQuickReply.findMany({
      where: { campaignId: campaign.id },
      orderBy: [{ sort: "asc" }, { createdAt: "asc" }],
    });
    const done = await replyOnce(ctx, "open", campaign.mainMessage, buildQuickReplies(execution.id, quickReplies));
    if (done) return done;
  }

  // Every tap (and a retry of the first one) may call this: a step is
  // scheduled once per execution, anchored at the first tap.
  if (execution.openedAt) {
    await scheduleFollowUps(execution, campaign, execution.openedAt, "opened");
  }
  return { status: "PROCESSED" };
}

async function runQuickReply(ctx: Ctx, quickReply: TriggerQuickReply): Promise<HandlerResult> {
  const { execution, event } = ctx;
  const campaign = execution.campaign;
  await touchInbound(execution, event.timestamp);

  if (quickReply.action === "MESSAGE") {
    return (await replyOnce(ctx, `qr:${quickReply.id}`, quickReply.responseText ?? "")) ?? { status: "PROCESSED" };
  }

  if (quickReply.action === "LEAD_CAPTURE") {
    const phone = parsePhone(event.text);
    if (!phone) return { status: "IGNORED", error: "Telefon raqami noto'g'ri yoki topilmadi." };
    await prisma.instagramContact.update({ where: { id: ctx.interaction.contact.id }, data: { phone: phone.e164 } });
    if (!execution.leadCapturedAt) await touchInbound(execution, event.timestamp, { leadCapturedAt: event.timestamp });
    await createJavobAiLeadFromTrigger(ctx, phone);
    const done = await replyOnce(ctx, `qr:${quickReply.id}`, quickReply.responseText?.trim() || DEFAULT_LEAD_THANKS);
    if (campaign.stopOnLead) await cancelFollowUps(execution.workspaceId, execution.id, "Lead olindi (telefon raqami)");
    return done ?? { status: "PROCESSED" };
  }

  // AI (ETAP 4): only a LIVE JavobAI account takes the thread; otherwise HANDOFF.
  if (quickReply.action === "AI") {
    const mode = await getJavobAiMode(event.instagramAccountId).catch(() => "OFF" as const);
    if (mode === "LIVE") return runAiQuickReply(ctx, quickReply);
  }

  // HANDOFF
  const firstHandoff = !execution.handedOffAt;
  if (firstHandoff) await touchInbound(execution, event.timestamp, { handedOffAt: event.timestamp });
  const done = await replyOnce(ctx, `qr:${quickReply.id}`, quickReply.responseText?.trim() || DEFAULT_HANDOFF_REPLY);
  if (campaign.stopOnHandoff) await cancelFollowUps(execution.workspaceId, execution.id, "Operatorga o'tkazildi");
  if (firstHandoff) {
    const who = ctx.interaction.contact.username ? `@${ctx.interaction.contact.username}` : event.senderId;
    await alertWorkspace(
      execution.workspaceId,
      "Instagram: mijoz operator so'radi",
      `<b>Operator kerak</b>\nKampaniya: ${escapeHtml(campaign.name)}\nMijoz: ${escapeHtml(who)}\nTugma: ${escapeHtml(quickReply.label)}`,
      `Operator kerak. Kampaniya: ${campaign.name}. Mijoz: ${who}. Tugma: ${quickReply.label}.`
    ).catch(() => {});
  }
  return done ?? { status: "PROCESSED" };
}

/**
 * Quick reply with action AI on a LIVE JavobAI account: the optional
 * response text goes out at once, the follow-ups stop (JavobAI owns the
 * thread now — also what frees it from the "trigger owns the thread" rule),
 * and JavobAI answers the tap through its own queue.
 */
async function runAiQuickReply(ctx: Ctx, quickReply: TriggerQuickReply): Promise<HandlerResult> {
  const { execution, event } = ctx;
  const done = await replyOnce(ctx, `qr:${quickReply.id}`, quickReply.responseText?.trim() ?? "");
  if (done) return done;
  await cancelFollowUps(execution.workspaceId, execution.id, AI_HANDOFF_REASON);
  await handJavobAiThread({
    account: event.instagramAccount,
    igUserId: event.senderId,
    igUsername: ctx.interaction.contact.username,
    messageId: event.messageId,
    text: quickReply.label,
    context: {
      campaignName: execution.campaign.name,
      executionId: execution.id,
      quickReplyLabel: quickReply.label,
      mainMessage: execution.campaign.mainMessage,
    },
  });
  return { status: "PROCESSED" };
}

/**
 * A LEAD_CAPTURE tap on a LIVE JavobAI account also creates a real Lead
 * (design, technical decisions). Best effort: the thank-you still goes out.
 */
async function createJavobAiLeadFromTrigger(ctx: Ctx, phone: ParsedPhone): Promise<void> {
  const { event, execution } = ctx;
  try {
    if ((await getJavobAiMode(event.instagramAccountId)) !== "LIVE") return;
    const [config, scoring] = await Promise.all([
      loadAccountConfig(event.instagramAccountId),
      loadScoringConfig(event.workspaceId, event.instagramAccountId),
    ]);
    await captureTriggerLead({
      account: event.instagramAccount,
      igUserId: event.senderId,
      igUsername: ctx.interaction.contact.username,
      phoneE164: phone.e164,
      phoneRaw: phone.raw,
      campaignName: execution.campaign.name,
      thresholds: scoring.thresholds,
      isTest: config.isTest,
    });
  } catch (error) {
    console.error("[Trigger Engine] JavobAI lead failed:", error instanceof Error ? error.message : error);
  }
}

type BaseCtx = Omit<Ctx, "execution">;

/** What runs for a plain DM after the bookkeeping (the DM-side triggers). */
export type PlainMessageHook = (interaction: RecordedInteraction) => Promise<HandlerResult>;

async function handlePlainMessage(base: BaseCtx, onPlainMessage?: PlainMessageHook): Promise<HandlerResult> {
  const { event, now } = base;
  // A flow run waiting for an answer (ETAP 6) takes the message: the handler half
  // of the webhook's findClaimedFlowMessages, using the same predicate.
  const flowResult = await handleFlowInbound(event);
  if (flowResult) return flowResult;

  // A phone shared from a LEAD_CAPTURE chip whose payload did not come back.
  // Same rule as the webhook route's claim, so the message is answered here
  // exactly when the keyword path and the assistant were kept away from it.
  if (phoneFromText(event.text)) {
    const pending = await findPendingLeadExecution(
      { id: event.instagramAccountId },
      event.senderId,
      now,
      event.timestamp
    );
    const leadQuickReply =
      pending &&
      (await prisma.triggerQuickReply.findFirst({
        where: { campaignId: pending.campaignId, action: "LEAD_CAPTURE" },
        orderBy: [{ sort: "asc" }, { createdAt: "asc" }],
      }));
    if (pending && leadQuickReply) {
      const ctx: Ctx = { ...base, execution: pending };
      try {
        return await runQuickReply(ctx, leadQuickReply);
      } finally {
        base.warning = ctx.warning;
      }
    }
  }

  // Only the threads still active at this message (same query as the webhook
  // claim's comment-thread check): a stale execution's window is never
  // reopened by a later DM. The event's own execution (a DM trigger answering
  // this very message) is not a previous conversation.
  const executions = await findActiveConversations({
    accountId: event.instagramAccountId,
    senderId: event.senderId,
    at: event.timestamp,
    eventTypes: CONVERSATION_EVENT_TYPES,
    excludeEventId: event.id,
  });

  for (const execution of executions) {
    await touchInbound(execution, event.timestamp);
    if (execution.campaign.stopOnReply && !execution.stoppedAt) {
      await cancelFollowUps(execution.workspaceId, execution.id, STOP_ON_REPLY_REASON);
    }
  }

  if (!onPlainMessage) {
    if (executions.length === 0) return { status: "IGNORED", error: "Bu odam uchun faol comment kampaniyasi yo'q" };
    return { status: "PROCESSED" };
  }

  const result = await onPlainMessage(base.interaction);
  // Nothing to answer, but the message was booked on earlier executions. The
  // comment-thread reason stays visible: it explains why Direct was quiet.
  if (result.status === "IGNORED" && executions.length > 0) {
    return { status: "PROCESSED", error: result.error === COMMENT_OWNS_THREAD_REASON ? result.error : undefined };
  }
  return result;
}

// ─── Entry ────────────────────────────────────────────────────────────────────

export async function handleDirectMessage(
  event: EventWithAccount,
  options: { onPlainMessage?: PlainMessageHook } = {}
): Promise<HandlerResult> {
  const base: BaseCtx = { event, interaction: await recordInteraction(event), now: new Date() };
  const result = await routeDirectMessage(base, options.onPlainMessage);
  // A reply not re-sent after an interrupted run is no error of this run, but it must be visible.
  if (base.warning && result.status === "PROCESSED" && !result.error) return { ...result, error: base.warning };
  return result;
}

async function routeDirectMessage(base: BaseCtx, onPlainMessage?: PlainMessageHook): Promise<HandlerResult> {
  const { event } = base;
  // A flow's own button / chip (ETAP 6): resume that run.
  if (isFlowPayload(event.payload)) return handleFlowTap(event);
  const c2 = parseC2Payload(event.payload);
  // A malformed "c2:" payload is still one of our taps, never a new DM.
  if (!c2) return handlePlainMessage(base, event.payload ? undefined : onPlainMessage);

  const execution = await prisma.triggerExecution.findFirst({
    where: { id: c2.executionId, workspaceId: event.workspaceId },
    include: { campaign: true, event: true },
  });
  // The payload is ours, but the tap must come from the person we wrote to,
  // on the same account — a forwarded or guessed payload changes nothing.
  if (
    !execution ||
    execution.event.instagramAccountId !== event.instagramAccountId ||
    execution.event.senderId !== event.senderId
  ) {
    return { status: "IGNORED", error: "Tugma bu odamga yoki akkauntga tegishli emas" };
  }
  if (!execution.campaign.active) {
    return { status: "IGNORED", error: "Kampaniya o'chirilgan" };
  }

  const ctx: Ctx = { ...base, execution };
  try {
    if (c2.action === "open") return await handleOpen(ctx);

    const quickReply = await prisma.triggerQuickReply.findFirst({
      where: { id: c2.quickReplyId, campaignId: execution.campaignId },
    });
    if (!quickReply) {
      await touchInbound(execution, event.timestamp);
      return { status: "IGNORED", error: "Tezkor javob tugmasi o'chirilgan" };
    }
    return await runQuickReply(ctx, quickReply);
  } finally {
    base.warning = ctx.warning;
  }
}
