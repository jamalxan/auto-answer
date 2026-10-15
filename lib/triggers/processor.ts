/**
 * Trigger Engine processor: one InstagramEvent in, one outcome out.
 *
 *   claim the event (lease) → handler for its type → finish with a status
 *
 * Handlers are registered per event type. V1 ships STORY_REPLY; every other
 * type is stored and marked IGNORED until its module lands, so adding Story
 * Mention or Direct later is a new handler, not a new pipeline.
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
import { markTokenBroken } from "@/lib/meta/token-health";
import { releaseWorkspaceDMReservation, reserveWorkspaceDMSend } from "@/lib/billing/usage";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";
import type {
  InstagramAccount,
  InstagramEvent,
  InstagramEventStatus,
  InstagramEventType,
} from "@/app/generated/prisma/client";
import { enrichContact, recordInteraction, storeMessage } from "./contacts";
import { classifySendError, TriggerRetryableError, type ClassifiedFailure } from "./errors";
import { selectCampaign } from "./matching";
import { backoffDelay, TRIGGER_MAX_ATTEMPTS } from "./queue";

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

type EventWithAccount = InstagramEvent & { instagramAccount: InstagramAccount };

interface HandlerResult {
  status: Extract<InstagramEventStatus, "PROCESSED" | "IGNORED" | "FAILED" | "RETRYING">;
  error?: string | null;
  errorDetail?: string | null;
  /** Why a RETRYING result failed; picks the retry delay. */
  kind?: ClassifiedFailure["kind"];
}

type EventHandler = (event: EventWithAccount) => Promise<HandlerResult>;

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

async function recordBackendFailure(event: EventWithAccount, failure: ClassifiedFailure, final: boolean) {
  console.error(
    `[Trigger Engine] ${event.eventType} ${event.id} send ${final ? "failed" : "will retry"}: ${failure.technical}`
  );
  if (!final) return;
  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: event.workspaceId,
        source: "WORKER",
        level: "ERROR",
        message: `Trigger engine: ${event.eventType} reply failed — ${failure.userMessage}`.slice(0, 500),
        payload: { eventId: event.id, kind: failure.kind, technical: failure.technical },
      },
    })
    .catch(() => {});
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

  const key = { eventId_campaignId: { eventId: event.id, campaignId: campaign.id } };
  let execution = await prisma.triggerExecution.findUnique({ where: key });

  if (execution?.status === "SENT" || execution?.status === "SKIPPED") {
    return { status: "PROCESSED" };
  }
  if (execution?.status === "SENDING") {
    // The previous run died between "about to send" and "sent". Instagram may
    // or may not have delivered it; a second DM is worse than none.
    const error = "Yuborish jarayoni uzildi — ikki marta yubormaslik uchun to'xtatildi. Kerak bo'lsa qo'lda qayta yuboring.";
    await prisma.triggerExecution.update({
      where: { id: execution.id },
      data: { status: "FAILED", error, errorDetail: "Found in SENDING state on re-run (worker crash mid-send)" },
    });
    return { status: "FAILED", error };
  }

  if (!execution) {
    execution = await prisma.triggerExecution.create({
      data: {
        workspaceId: event.workspaceId,
        eventId: event.id,
        campaignId: campaign.id,
        status: "PENDING",
        matchedKeyword: selection.matchedKeyword,
        responseText: campaign.responseMessage,
      },
    });
  }
  const executionId = execution.id;

  const failExecution = async (failure: ClassifiedFailure): Promise<HandlerResult> => {
    const final = !failure.retryable || event.attempts >= TRIGGER_MAX_ATTEMPTS;
    await prisma.triggerExecution.update({
      where: { id: executionId },
      data: {
        status: final ? "FAILED" : "RETRYING",
        error: failure.userMessage,
        errorDetail: failure.technical,
        nextRetryAt: final ? null : new Date(Date.now() + backoffDelay(event.attempts, failure.kind)),
      },
    });
    await recordBackendFailure(event, failure, final);
    if (final) return { status: "FAILED", error: failure.userMessage, errorDetail: failure.technical };
    return { status: "RETRYING", error: failure.userMessage, errorDetail: failure.technical, kind: failure.kind };
  };

  // Token
  if (!account.accessToken || account.tokenStatus === "BROKEN") {
    return failExecution({
      kind: "token",
      retryable: false,
      userMessage: "Instagram ulanishi uzilgan — akkauntni qayta ulang.",
      technical: account.accessToken ? `tokenStatus=BROKEN: ${account.tokenLastError ?? "-"}` : "No access token",
    });
  }
  let accessToken: string;
  try {
    accessToken = decryptToken(account.accessToken);
  } catch (error) {
    return failExecution({
      kind: "token",
      retryable: false,
      userMessage: "Instagram tokenini o'qib bo'lmadi — akkauntni qayta ulang.",
      technical: `decryptToken: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Workspace (platform suspension + usage counter)
  const usage = await reserveWorkspaceDMSend(event.workspaceId);
  if (!usage.allowed) {
    const error =
      usage.reason === "suspended" ? "Workspace platforma admini tomonidan to'xtatilgan." : "Oylik DM limiti tugagan.";
    await prisma.triggerExecution.update({
      where: { id: executionId },
      data: { status: "SKIPPED", error, errorDetail: `reserveWorkspaceDMSend: ${usage.reason ?? "denied"}` },
    });
    return { status: "PROCESSED", error };
  }

  // From here until the send, anything that throws must hand the workspace
  // reservation back, or the monthly counter keeps a DM that never went out.
  const releasingOnError = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      await releaseWorkspaceDMReservation(event.workspaceId, usage.periodStart).catch(() => {});
      throw error;
    }
  };

  // Per-account hourly cap shared with the comment→DM campaigns.
  const slot = await releasingOnError(() => reserveDMSlot(account.instagramId));
  if (!slot.allowed) {
    await releaseWorkspaceDMReservation(event.workspaceId, usage.periodStart);
    return failExecution({
      kind: "rate_limit",
      retryable: true,
      userMessage: "Soatlik DM limiti to'lgan — keyinroq qayta yuboriladi.",
      technical: `reserveDMSlot: count=${slot.currentCount}`,
    });
  }

  await releasingOnError(() =>
    prisma.triggerExecution.update({
      where: { id: executionId },
      data: { status: "SENDING", attempts: { increment: 1 }, nextRetryAt: null },
    })
  );

  let sent: { recipient_id: string; message_id: string };
  try {
    sent = await sendDirectMessage(accessToken, account.instagramId, event.senderId, campaign.responseMessage);
  } catch (error) {
    await releaseWorkspaceDMReservation(event.workspaceId, usage.periodStart).catch(() => {});
    const failure = classifySendError(error);
    if (failure.kind === "token") {
      await markTokenBroken(account.id, failure.technical).catch(() => {});
    }
    return failExecution(failure);
  }

  await prisma.triggerExecution.update({
    where: { id: executionId },
    data: {
      status: "SENT",
      sentAt: new Date(),
      sentMessageId: sent.message_id ?? null,
      error: null,
      errorDetail: null,
      nextRetryAt: null,
    },
  });
  await storeMessage({
    conversationId: interaction.conversation.id,
    direction: "OUTBOUND",
    text: campaign.responseMessage,
    mid: sent.message_id ?? null,
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
