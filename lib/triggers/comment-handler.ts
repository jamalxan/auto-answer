/**
 * COMMENT handler — Comment Automation 2.0.
 *
 *   comment ─▶ contact ─▶ campaign (keywords / intents / priority)
 *           ─▶ TriggerExecution ─▶ public reply (optional, independent)
 *                               ─▶ private reply [+ opening button "c2:<execution>:open"]
 *
 * Meta rules followed here:
 *   - a private reply only within 7 days of the comment, one per comment —
 *     older comments are SKIPPED with the reason, and a comment production
 *     already answered privately is never answered again;
 *   - the private reply is one message; the main message, quick replies and
 *     follow-ups wait for the person to tap the button (direct-handler.ts).
 *
 * Idempotency is the processor's: one execution per (event, campaign), SENT
 * ends the job, a leftover SENDING fails instead of re-sending. The public
 * reply is posted at most once: a marker is written before the call, and a
 * retry that finds the marker without a result records FAILED instead of
 * posting again.
 */

import { prisma } from "@/lib/db/client";
import { sendCommentReply, sendPrivateReply, sendPrivateReplyWithButton } from "@/lib/meta/client";
import type { TriggerCampaign, TriggerExecution } from "@/app/generated/prisma/client";
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
import { describeCommentMatch, selectCommentCampaign, type CommentMatchKind } from "./matching";
import { chooseReplies, loadApprovedVariants, pickVariant, usableVariants } from "./variants";

/** Meta: a private reply is accepted within 7 days of the comment. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600_000;

export const EXPIRED_REASON = "Izoh 7 kundan eski — Instagram unga shaxsiy javob yuborishga ruxsat bermaydi.";
const PUBLIC_REPLY_IN_FLIGHT = "__posting__";

export function isPrivateReplyExpired(commentAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - commentAt.getTime() >= PRIVATE_REPLY_WINDOW_MS;
}

/** The opening button's postback payload; parsed back in direct-handler.ts. */
export function openPayload(executionId: string): string {
  return `c2:${executionId}:open`;
}

/** A comment on an ad: the organic post it was made from (campaigns point at that). */
function originalMediaId(rawPayload: unknown): string | null {
  const item = (rawPayload as { item?: { value?: { media?: { original_media_id?: unknown } } } } | null)?.item;
  const id = item?.value?.media?.original_media_id;
  return typeof id === "string" && id ? id : null;
}

function classifyPrivateReplyError(error: unknown): ClassifiedFailure {
  const failure = classifySendError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid for a private reply/i.test(message)) {
    // The one private reply for this comment is used up — no retry fixes it.
    return {
      ...failure,
      kind: "permission",
      retryable: false,
      userMessage: "Bu izohga shaxsiy javob allaqachon yuborilgan yoki muddati o'tgan.",
    };
  }
  return failure;
}

async function loadCommentCampaigns(accountId: string, backtrackRunId: string | null) {
  // A backtrack event was queued for one campaign: only that one may answer it.
  let campaignId: string | undefined;
  if (backtrackRunId) {
    const run = await prisma.triggerBacktrackRun.findUnique({
      where: { id: backtrackRunId },
      select: { campaignId: true },
    });
    campaignId = run?.campaignId ?? "__none__";
  }
  return prisma.triggerCampaign.findMany({
    where: { instagramAccountId: accountId, triggerType: "COMMENT", active: true, ...(campaignId ? { id: campaignId } : {}) },
    orderBy: { createdAt: "asc" },
  });
}

async function postPublicReply(
  execution: TriggerExecution,
  campaign: TriggerCampaign,
  publicText: string | null,
  accessToken: string,
  commentId: string
) {
  if (!campaign.publicReplyEnabled || execution.publicReplyStatus) return;

  if (execution.publicReplyError === PUBLIC_REPLY_IN_FLIGHT) {
    // An earlier run died mid-call: the reply may be under the post already.
    await prisma.triggerExecution.update({
      where: { id: execution.id },
      data: { publicReplyStatus: "FAILED", publicReplyError: "Ochiq javob jarayoni uzildi — ikki marta yozmaslik uchun qayta yuborilmadi." },
    });
    return;
  }

  let text = publicText;
  if (text === null) {
    // A retry run: the text was not kept, pick again without moving the cursor.
    const variants = usableVariants(await loadApprovedVariants(campaign.id), "PUBLIC");
    text = pickVariant(variants, campaign.replyMode, campaign.sequenceCursor)?.text ?? null;
  }
  if (!text) return; // no approved public variant

  await prisma.triggerExecution.update({
    where: { id: execution.id },
    data: { publicReplyError: PUBLIC_REPLY_IN_FLIGHT },
  });
  try {
    await sendCommentReply(accessToken, commentId, text);
    await prisma.triggerExecution.update({
      where: { id: execution.id },
      data: { publicReplyStatus: "SENT", publicReplyError: null },
    });
  } catch (error) {
    // Independent of the DM: logged on the execution, never retried.
    const failure = classifySendError(error);
    console.error("[Trigger Engine] public comment reply failed:", failure.technical);
    await prisma.triggerExecution
      .update({
        where: { id: execution.id },
        data: { publicReplyStatus: "FAILED", publicReplyError: `${failure.userMessage} (${failure.technical})`.slice(0, 1000) },
      })
      .catch(() => {});
  }
}

export async function handleComment(event: EventWithAccount): Promise<HandlerResult> {
  const account = event.instagramAccount;
  if (event.senderId === account.instagramId) {
    return { status: "IGNORED", error: "Akkauntning o'z izohi" };
  }

  const interaction = await recordInteraction(event);
  if (account.accessToken && account.tokenStatus !== "BROKEN") {
    const token = readAccessToken(account);
    if (token.ok) interaction.contact = await enrichContact(interaction.contact, token.token);
  }

  const campaigns = await loadCommentCampaigns(account.id, event.backtrackRunId ?? null);
  const selection = selectCommentCampaign(campaigns, {
    mediaId: event.mediaId,
    altMediaId: originalMediaId(event.rawPayload),
    text: event.text,
  });
  if (!selection.campaign) return { status: "IGNORED", error: selection.ignoredReason };
  const campaign = selection.campaign;
  const matchedKeyword = describeCommentMatch(selection);
  const expired = isPrivateReplyExpired(event.timestamp);

  let publicText: string | null = null;
  const start = await beginExecution(event, campaign.id, async () => {
    if (expired) return { matchedKeyword, responseText: campaign.responseMessage };
    const chosen = await chooseReplies(campaign, await loadApprovedVariants(campaign.id));
    publicText = chosen.publicText;
    return { matchedKeyword, responseText: chosen.dm.text, variantId: chosen.dm.variantId };
  });
  if ("done" in start) return start.done;
  const execution = start.execution;

  if (expired) {
    return skipExecution(execution.id, EXPIRED_REASON, `comment at ${event.timestamp.toISOString()}`);
  }

  // Production may have answered this comment before the campaign existed (or
  // while the claim cache was stale): Meta allows one private reply in total.
  const answeredByProduction = await prisma.dmLog.findFirst({
    where: { commentId: event.messageId, status: "SENT" },
    select: { id: true },
  });
  if (answeredByProduction) {
    return skipExecution(
      execution.id,
      "Bu izohga boshqa kampaniya allaqachon shaxsiy javob yuborgan.",
      `DmLog ${answeredByProduction.id} SENT for comment ${event.messageId}`
    );
  }

  const token = readAccessToken(account);
  if (!token.ok) return failExecution(event, execution.id, token.failure);
  const accessToken = token.token;

  await postPublicReply(execution, campaign, publicText, accessToken, event.messageId);

  const text = execution.responseText;
  const buttonLabel = campaign.openingButtonLabel?.trim() || null;
  const result = await sendGuarded(
    event.workspaceId,
    account,
    () =>
      buttonLabel
        ? sendPrivateReplyWithButton(accessToken, account.instagramId, event.messageId, text, buttonLabel, openPayload(execution.id))
        : sendPrivateReply(accessToken, account.instagramId, event.messageId, text),
    { beforeSend: () => markExecutionSending(execution.id), classify: classifyPrivateReplyError }
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

// ─── Simulator ────────────────────────────────────────────────────────────────

export interface CommentSimulation {
  matched: boolean;
  campaignId?: string;
  campaignName?: string;
  matchKind?: CommentMatchKind;
  matchedKeyword?: string;
  dmPreview?: string;
  publicPreview?: string;
  reason?: string;
}

/**
 * Dry run: which campaign would answer this comment, and with what. Sends
 * nothing, writes nothing (the SEQUENTIAL cursor is read, not moved).
 * `eventType: "LIVE_COMMENT"` checks the live-comment campaigns instead (they
 * never post a public reply).
 */
export async function simulateComment(
  workspaceId: string,
  input: { instagramAccountId: string; mediaId: string | null; text: string; eventType?: "COMMENT" | "LIVE_COMMENT" }
): Promise<CommentSimulation> {
  const eventType = input.eventType ?? "COMMENT";
  const campaigns = await prisma.triggerCampaign.findMany({
    where: {
      workspaceId,
      triggerType: eventType,
      active: true,
      OR: [{ instagramAccountId: input.instagramAccountId }, { instagramAccount: { instagramId: input.instagramAccountId } }],
    },
    orderBy: { createdAt: "asc" },
  });
  const selection = selectCommentCampaign(campaigns, { mediaId: input.mediaId || null, text: input.text, eventType });
  if (!selection.campaign || !selection.matchKind) {
    return { matched: false, reason: selection.ignoredReason ?? "Mos kampaniya topilmadi" };
  }

  const campaign = selection.campaign;
  const chosen = await chooseReplies(campaign, await loadApprovedVariants(campaign.id), { dryRun: true });
  return {
    matched: true,
    campaignId: campaign.id,
    campaignName: campaign.name,
    matchKind: selection.matchKind,
    matchedKeyword: describeCommentMatch(selection) ?? undefined,
    dmPreview: chosen.dm.text,
    publicPreview:
      eventType === "COMMENT" && campaign.publicReplyEnabled && chosen.publicText ? chosen.publicText : undefined,
  };
}
