/**
 * Trigger Engine processor: one InstagramEvent in, one outcome out.
 *
 *   claim the event (lease) → handler for its type → finish with a status
 *
 * Handlers are registered per event type: STORY_REPLY, COMMENT and
 * DIRECT_MESSAGE (Comment 2.0's button / quick-reply taps and replies).
 * STORY_MENTION and LIVE_COMMENT are stored and marked IGNORED until their
 * module lands — a new handler, not a new pipeline. The shared send path
 * (token, quota, rate limit, execution lifecycle) is in delivery.ts.
 *
 * Duplicate protection, layer two (layer one is the unique event row):
 *   - the claim is an atomic status flip, so two jobs for one event cannot
 *     both run it;
 *   - TriggerExecution is unique per (event, campaign) and is checked before
 *     sending — a SENT row ends the job, a SENDING row (the process died
 *     mid-send) stops it rather than risk a second DM.
 *
 * Retries use the attempt counter on the event row, not the BullMQ job, so a
 * sweep or a manual retry never resets the budget by accident.
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { sendDirectMessage } from "@/lib/meta/client";
import type { InstagramEventType } from "@/app/generated/prisma/client";
import { handleComment } from "./comment-handler";
import { enrichContact, recordInteraction, storeMessage } from "./contacts";
import {
  beginExecution,
  failExecution,
  markExecutionSending,
  markExecutionSent,
  readAccessToken,
  sendGuarded,
  skipExecution,
  type EventHandler,
  type EventWithAccount,
  type HandlerResult,
} from "./delivery";
import { handleDirectMessage } from "./direct-handler";
import { TriggerRetryableError } from "./errors";
import { selectCampaign } from "./matching";
import { TRIGGER_MAX_ATTEMPTS } from "./queue";

export type { EventWithAccount, HandlerResult } from "./delivery";

/** A PROCESSING claim older than this is treated as abandoned (crashed worker). */
export const PROCESSING_LEASE_MS = 5 * 60_000;

export type ProcessOutcome =
  | "processed"
  | "ignored"
  | "failed"
  | "retrying"
  | "already_done"
  | "busy"
  | "missing";

// ─── Claim / finish ───────────────────────────────────────────────────────────

async function claimEvent(eventId: string): Promise<boolean> {
  const now = new Date();
  const claimed = await prisma.instagramEvent.updateMany({
    where: {
      id: eventId,
      OR: [
        { processingStatus: { in: ["PENDING", "RETRYING"] } },
        { processingStatus: "PROCESSING", processingStartedAt: { lt: new Date(now.getTime() - PROCESSING_LEASE_MS) } },
      ],
    },
    data: { processingStatus: "PROCESSING", processingStartedAt: now, attempts: { increment: 1 } },
  });
  return claimed.count > 0;
}

async function finishEvent(eventId: string, result: HandlerResult) {
  const final = result.status !== "RETRYING";
  await prisma.instagramEvent.update({
    where: { id: eventId },
    data: {
      processingStatus: result.status,
      error: result.error ?? null,
      errorDetail: result.errorDetail ?? null,
      processingStartedAt: null,
      processedAt: final ? new Date() : null,
    },
  });
}

// ─── STORY_REPLY ──────────────────────────────────────────────────────────────

export async function handleStoryReply(event: EventWithAccount): Promise<HandlerResult> {
  const account = event.instagramAccount;
  const interaction = await recordInteraction(event);

  // Username / name for the contact and the log, ignored replies included.
  // Best effort: the strict token checks before sending come further down.
  if (account.accessToken && account.tokenStatus !== "BROKEN") {
    try {
      interaction.contact = await enrichContact(interaction.contact, decryptToken(account.accessToken));
    } catch {
      // unreadable token — reported below if a reply has to go out
    }
  }

  const campaigns = await prisma.triggerCampaign.findMany({
    where: { instagramAccountId: account.id, triggerType: "STORY_REPLY", active: true },
    orderBy: { createdAt: "asc" },
  });
  const selection = selectCampaign(campaigns, {
    type: "STORY_REPLY",
    text: event.text,
    storyId: event.storyId,
  });
  if (!selection.campaign) {
    return { status: "IGNORED", error: selection.ignoredReason };
  }
  const campaign = selection.campaign;

  const start = await beginExecution(event, campaign.id, () => ({
    matchedKeyword: selection.matchedKeyword,
    responseText: campaign.responseMessage,
  }));
  if ("done" in start) return start.done;
  const executionId = start.execution.id;

  const token = readAccessToken(account);
  if (!token.ok) return failExecution(event, executionId, token.failure);
  const accessToken = token.token;

  const result = await sendGuarded(
    event.workspaceId,
    account,
    () => sendDirectMessage(accessToken, account.instagramId, event.senderId, campaign.responseMessage),
    { beforeSend: () => markExecutionSending(executionId) }
  );
  if (!result.ok) {
    if (result.skipped) return skipExecution(executionId, result.error, result.errorDetail);
    return failExecution(event, executionId, result.failure);
  }

  await markExecutionSent(executionId, result.sent);
  await storeMessage({
    conversationId: interaction.conversation.id,
    direction: "OUTBOUND",
    text: campaign.responseMessage,
    mid: result.sent.message_id ?? null,
    eventId: event.id,
    executionId,
  }).catch((error) => {
    // The DM is out; failing the event now would only invite a duplicate.
    console.error("[Trigger Engine] outbound message not stored:", error instanceof Error ? error.message : error);
  });

  return { status: "PROCESSED" };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const EVENT_HANDLERS: Partial<Record<InstagramEventType, EventHandler>> = {
  STORY_REPLY: handleStoryReply,
  // Comment Automation 2.0 (lib/triggers/comment-handler.ts, direct-handler.ts)
  COMMENT: handleComment,
  DIRECT_MESSAGE: handleDirectMessage,
};

const NOT_YET_SUPPORTED = "Bu event turi hali ishga tushirilmagan (keyingi bosqich).";

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function processInstagramEvent(eventId: string): Promise<ProcessOutcome> {
  if (!(await claimEvent(eventId))) {
    const current = await prisma.instagramEvent.findUnique({
      where: { id: eventId },
      select: { processingStatus: true },
    });
    if (!current) return "missing";
    if (current.processingStatus === "PROCESSING") return "busy";
    return "already_done";
  }

  const event = await prisma.instagramEvent.findUnique({
    where: { id: eventId },
    include: { instagramAccount: true },
  });
  if (!event) return "missing";

  const handler = EVENT_HANDLERS[event.eventType];
  let result: HandlerResult;
  try {
    result = handler ? await handler(event) : { status: "IGNORED", error: NOT_YET_SUPPORTED };
  } catch (error) {
    // Our own failure (database, Redis...), not Instagram's. Release the claim
    // so the retry does not wait for the lease to expire.
    const technical = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const final = event.attempts >= TRIGGER_MAX_ATTEMPTS;
    await finishEvent(eventId, {
      status: final ? "FAILED" : "RETRYING",
      error: "Ichki xatolik — tizim qayta urinadi.",
      errorDetail: technical.slice(0, 2000),
    }).catch(() => {});
    if (final) return "failed";
    throw error;
  }

  await finishEvent(eventId, result);
  if (result.status === "RETRYING") {
    throw new TriggerRetryableError({
      kind: result.kind ?? "temporary",
      retryable: true,
      userMessage: result.error ?? "",
      technical: result.errorDetail ?? result.error ?? "retry",
    });
  }
  if (result.status === "IGNORED") return "ignored";
  if (result.status === "FAILED") return "failed";
  return "processed";
}
