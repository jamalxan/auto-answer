/**
 * LIVE_COMMENT handler (ETAP 3) — a comment under a live broadcast.
 *
 * LIVE_COMMENT campaigns are configured like Comment 2.0 campaigns (variants,
 * opening button, main message, quick replies, follow-ups) and answered the
 * same way — one private reply, optionally with the "c2:<execution>:open"
 * button, whose tap continues in direct-handler.ts — except:
 *   - no public reply and no backtrack;
 *   - media scope is always "any broadcast" (matching.ts);
 *   - Meta accepts a private reply to a live comment only while the broadcast
 *     runs. Instead of the 7-day rule, a comment older than the longest
 *     possible broadcast (4 hours) is skipped, and a private reply Meta
 *     refuses is FINAL: no retries, the broadcast has most likely ended.
 *     Only our own hourly slot (nothing was sent) waits for a retry, and the
 *     age rule still applies when it comes.
 *
 * Production does not subscribe to live comments (lib/meta/webhook.ts reads
 * `comments` only), so nothing has to be claimed away from it.
 */

import { prisma } from "@/lib/db/client";
import { startFlowFromCampaign } from "@/lib/flows/bridge";
import { flowKindFilter } from "@/lib/flows/config";
import { sendPrivateReply, sendPrivateReplyWithButton } from "@/lib/meta/client";
import { openPayload } from "./comment-handler";
import { enrichContact, recordInteraction, storeMessage } from "./contacts";
import {
  beginExecution,
  failExecution,
  markExecutionSending,
  markExecutionSent,
  readAccessToken,
  sendGuarded,
  skipExecution,
  type EventWithAccount,
  type HandlerResult,
} from "./delivery";
import { classifySendError, type ClassifiedFailure } from "./errors";
import { scheduleFollowUps } from "./followups";
import { describeCommentMatch, selectCommentCampaign } from "./matching";
import { chooseReplies, loadApprovedVariants } from "./variants";

/** Instagram Live broadcasts last at most 4 hours. */
export const LIVE_MAX_MS = 4 * 3600_000;
export const LIVE_ENDED_REASON = "Efir tugagan yoki private reply muddati o'tgan — Instagram javobni qabul qilmadi.";
export const LIVE_TOO_OLD_REASON = "Jonli efir izohi 4 soatdan eski — efir tugagan, shaxsiy javob yuborilmadi.";

/**
 * Every refusal from Meta is final for a live comment. A broken token keeps
 * its own message (the account must be reconnected), Meta's rate limit says
 * so; everything else most likely means the broadcast is over.
 */
export function classifyLiveReplyError(error: unknown): ClassifiedFailure {
  const failure = classifySendError(error);
  if (failure.kind === "token") return { ...failure, retryable: false };
  if (failure.kind === "rate_limit") {
    return { ...failure, retryable: false, userMessage: "Instagram limitiga yetildi — jonli efir izohiga qayta urinilmaydi." };
  }
  return { ...failure, retryable: false, userMessage: LIVE_ENDED_REASON };
}

export function isLiveCommentTooOld(commentAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - commentAt.getTime() >= LIVE_MAX_MS;
}

export async function handleLiveComment(event: EventWithAccount): Promise<HandlerResult> {
  const account = event.instagramAccount;
  if (event.senderId === account.instagramId) {
    return { status: "IGNORED", error: "Akkauntning o'z izohi" };
  }

  const interaction = await recordInteraction(event);
  if (account.accessToken && account.tokenStatus !== "BROKEN") {
    const token = readAccessToken(account);
    if (token.ok) interaction.contact = await enrichContact(interaction.contact, token.token);
  }

  const campaigns = await prisma.triggerCampaign.findMany({
    where: { instagramAccountId: account.id, triggerType: "LIVE_COMMENT", active: true, ...flowKindFilter() },
    orderBy: { createdAt: "asc" },
  });
  const selection = selectCommentCampaign(campaigns, { mediaId: event.mediaId, text: event.text, eventType: "LIVE_COMMENT" });
  if (!selection.campaign) return { status: "IGNORED", error: selection.ignoredReason };
  const campaign = selection.campaign;
  const matchedKeyword = describeCommentMatch(selection);
  // ETAP 6: a published flow answers instead of the campaign's own message.
  if (campaign.kind === "FLOW") return startFlowFromCampaign(event, campaign, interaction, matchedKeyword);
  const tooOld = isLiveCommentTooOld(event.timestamp);

  const start = await beginExecution(event, campaign.id, async () => {
    if (tooOld) return { matchedKeyword, responseText: campaign.responseMessage };
    const chosen = await chooseReplies(campaign, await loadApprovedVariants(campaign.id));
    return { matchedKeyword, responseText: chosen.dm.text, variantId: chosen.dm.variantId };
  });
  if ("done" in start) return start.done;
  const execution = start.execution;

  if (tooOld) return skipExecution(execution.id, LIVE_TOO_OLD_REASON, `live comment at ${event.timestamp.toISOString()}`);

  const token = readAccessToken(account);
  if (!token.ok) return failExecution(event, execution.id, token.failure);
  const accessToken = token.token;

  const text = execution.responseText;
  const buttonLabel = campaign.openingButtonLabel?.trim() || null;
  const result = await sendGuarded(
    event.workspaceId,
    account,
    () =>
      buttonLabel
        ? sendPrivateReplyWithButton(accessToken, account.instagramId, event.messageId, text, buttonLabel, openPayload(execution.id))
        : sendPrivateReply(accessToken, account.instagramId, event.messageId, text),
    { beforeSend: () => markExecutionSending(execution.id), classify: classifyLiveReplyError }
  );
  if (!result.ok) {
    if (result.skipped) return skipExecution(execution.id, result.error, result.errorDetail);
    return failExecution(event, execution.id, result.failure);
  }

  const sentAt = new Date();
  await markExecutionSent(execution.id, result.sent, sentAt);
  await storeMessage({
    conversationId: interaction.conversation.id,
    direction: "OUTBOUND",
    text,
    mid: result.sent.message_id ?? null,
    eventId: event.id,
    executionId: execution.id,
  }).catch((error) => {
    // The DM is out; failing the event now would only invite a duplicate.
    console.error("[Trigger Engine] outbound message not stored:", error instanceof Error ? error.message : error);
  });
  await scheduleFollowUps(execution, campaign, sentAt, "sent").catch((error) => {
    console.error("[Trigger Engine] follow-ups not scheduled:", error instanceof Error ? error.message : error);
  });

  return { status: "PROCESSED" };
}
