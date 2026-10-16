/**
 * Shared send path for every trigger handler (story reply, comment, direct,
 * follow-up sweep). Lives apart from processor.ts so the handlers can use it
 * without an import cycle through the handler registry.
 *
 *   token → workspace DM quota → hourly per-account slot → send
 *
 * Whatever goes wrong after the quota reservation hands it back, so the
 * monthly counter only keeps DMs that really went out.
 *
 * Executions (one per event + campaign) follow the same lifecycle everywhere:
 * SENT / SKIPPED end the job, a leftover SENDING (process died mid-send)
 * fails instead of risking a second DM, anything else is (re)tried.
 */

import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import { markTokenBroken } from "@/lib/meta/token-health";
import { releaseWorkspaceDMReservation, reserveWorkspaceDMSend } from "@/lib/billing/usage";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";
import type {
  InstagramAccount,
  InstagramEvent,
  InstagramEventStatus,
  TriggerExecution,
} from "@/app/generated/prisma/client";
import { classifySendError, type ClassifiedFailure } from "./errors";
import { isRateLimitExpired, RATE_LIMIT_EXPIRED_MESSAGE } from "@/lib/utils/rate-limit-age";
import { backoffDelay, TRIGGER_MAX_ATTEMPTS } from "./queue";

export type EventWithAccount = InstagramEvent & { instagramAccount: InstagramAccount };

export interface HandlerResult {
  status: Extract<InstagramEventStatus, "PROCESSED" | "IGNORED" | "FAILED" | "RETRYING">;
  error?: string | null;
  errorDetail?: string | null;
  /** Why a RETRYING result failed; picks the retry delay. */
  kind?: ClassifiedFailure["kind"];
  /** Rate-limit retries: the TTL-based wait computed at the send (see ClassifiedFailure.retryAfterMs). */
  retryAfterMs?: number;
}

export type EventHandler = (event: EventWithAccount) => Promise<HandlerResult>;

export interface SentMessage {
  recipient_id?: string;
  message_id?: string;
}

// ─── Backend log ──────────────────────────────────────────────────────────────

export async function recordBackendFailure(
  event: { id: string; workspaceId: string; eventType: string },
  failure: ClassifiedFailure,
  final: boolean
) {
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

// ─── Token ────────────────────────────────────────────────────────────────────

export type TokenResult = { ok: true; token: string } | { ok: false; failure: ClassifiedFailure };

export function readAccessToken(account: Pick<InstagramAccount, "accessToken" | "tokenStatus" | "tokenLastError">): TokenResult {
  if (!account.accessToken || account.tokenStatus === "BROKEN") {
    return {
      ok: false,
      failure: {
        kind: "token",
        retryable: false,
        userMessage: "Instagram ulanishi uzilgan — akkauntni qayta ulang.",
        technical: account.accessToken ? `tokenStatus=BROKEN: ${account.tokenLastError ?? "-"}` : "No access token",
      },
    };
  }
  try {
    return { ok: true, token: decryptToken(account.accessToken) };
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "token",
        retryable: false,
        userMessage: "Instagram tokenini o'qib bo'lmadi — akkauntni qayta ulang.",
        technical: `decryptToken: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

// ─── Guarded send ─────────────────────────────────────────────────────────────

export type GuardedSendResult =
  | { ok: true; sent: SentMessage }
  /** Workspace suspended / monthly limit: not an error, nothing to retry. */
  | { ok: false; skipped: true; error: string; errorDetail: string }
  | { ok: false; skipped: false; failure: ClassifiedFailure };

/**
 * Quota + rate limit around one Instagram send. `beforeSend` runs once both
 * are reserved (e.g. mark the execution SENDING); `classify` lets a handler
 * refine Meta's error before the token / retry decision.
 */
export async function sendGuarded(
  workspaceId: string,
  account: Pick<InstagramAccount, "id" | "instagramId">,
  send: () => Promise<SentMessage>,
  options: {
    beforeSend?: () => Promise<unknown>;
    classify?: (error: unknown) => ClassifiedFailure;
  } = {}
): Promise<GuardedSendResult> {
  const usage = await reserveWorkspaceDMSend(workspaceId);
  if (!usage.allowed) {
    return {
      ok: false,
      skipped: true,
      error: usage.reason === "suspended" ? "Workspace platforma admini tomonidan to'xtatilgan." : "Oylik DM limiti tugagan.",
      errorDetail: `reserveWorkspaceDMSend: ${usage.reason ?? "denied"}`,
    };
  }

  // From here until the send, anything that throws must hand the workspace
  // reservation back, or the monthly counter keeps a DM that never went out.
  const releasingOnError = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      await releaseWorkspaceDMReservation(workspaceId, usage.periodStart).catch(() => {});
      throw error;
    }
  };

  // Per-account hourly cap shared with the comment→DM campaigns.
  const slot = await releasingOnError(() => reserveDMSlot(account.instagramId));
  if (!slot.allowed) {
    await releaseWorkspaceDMReservation(workspaceId, usage.periodStart);
    return {
      ok: false,
      skipped: false,
      failure: {
        kind: "rate_limit",
        retryable: true,
        userMessage: "Soatlik DM limiti to'lgan — keyinroq qayta yuboriladi.",
        technical: `reserveDMSlot: count=${slot.currentCount}`,
        retryAfterMs: slot.requeueDelayMs,
      },
    };
  }

  if (options.beforeSend) await releasingOnError(options.beforeSend);

  try {
    return { ok: true, sent: await send() };
  } catch (error) {
    await releaseWorkspaceDMReservation(workspaceId, usage.periodStart).catch(() => {});
    const failure = (options.classify ?? classifySendError)(error);
    if (failure.kind === "token") {
      await markTokenBroken(account.id, failure.technical).catch(() => {});
    }
    return { ok: false, skipped: false, failure };
  }
}

// ─── Execution lifecycle ──────────────────────────────────────────────────────

export interface ExecutionInit {
  matchedKeyword: string | null;
  responseText: string;
  variantId?: string | null;
}

export type ExecutionStart = { done: HandlerResult } | { execution: TriggerExecution; created: boolean };

/**
 * Find or create the execution for (event, campaign). `init` runs only when
 * the row is created, so choices made there (reply variant, sequence cursor)
 * happen once per event, never once per attempt.
 */
export async function beginExecution(
  event: { id: string; workspaceId: string },
  campaignId: string,
  init: () => Promise<ExecutionInit> | ExecutionInit
): Promise<ExecutionStart> {
  const key = { eventId_campaignId: { eventId: event.id, campaignId } };
  const execution = await prisma.triggerExecution.findUnique({ where: key });

  if (execution?.status === "SENT" || execution?.status === "SKIPPED") {
    return { done: { status: "PROCESSED" } };
  }
  if (execution?.status === "SENDING") {
    // The previous run died between "about to send" and "sent". Instagram may
    // or may not have delivered it; a second DM is worse than none.
    const error = "Yuborish jarayoni uzildi — ikki marta yubormaslik uchun to'xtatildi. Kerak bo'lsa qo'lda qayta yuboring.";
    await prisma.triggerExecution.update({
      where: { id: execution.id },
      data: { status: "FAILED", error, errorDetail: "Found in SENDING state on re-run (worker crash mid-send)" },
    });
    return { done: { status: "FAILED", error } };
  }
  if (execution) return { execution, created: false };

  const data = await init();
  const created = await prisma.triggerExecution.create({
    data: {
      workspaceId: event.workspaceId,
      eventId: event.id,
      campaignId,
      status: "PENDING",
      matchedKeyword: data.matchedKeyword,
      responseText: data.responseText,
      ...(data.variantId !== undefined ? { variantId: data.variantId } : {}),
    },
  });
  return { execution: created, created: true };
}

// ─── Rate-limit age cap ───────────────────────────────────────────────────────

export interface EventAge {
  /** The comment / message time; falls back to when the event row was created. */
  timestamp?: Date | null;
  createdAt?: Date | null;
}

/**
 * A send held back by the hourly cap is retried until the event is too old to
 * deliver (24h for DMs, 7 days for private replies to comments): then it
 * fails for good with a clear reason instead of cycling forever.
 */
export function capRateLimitAge(event: EventAge & { eventType: string }, failure: ClassifiedFailure, now: Date = new Date()): ClassifiedFailure {
  if (failure.kind !== "rate_limit" || !failure.retryable) return failure;
  const kind = event.eventType === "COMMENT" || event.eventType === "LIVE_COMMENT" ? "private_reply" : "dm";
  if (!isRateLimitExpired(event.timestamp ?? event.createdAt, kind, now)) return failure;
  return { ...failure, retryable: false, userMessage: RATE_LIMIT_EXPIRED_MESSAGE };
}

function retrying(failure: ClassifiedFailure): HandlerResult {
  return {
    status: "RETRYING",
    error: failure.userMessage,
    errorDetail: failure.technical,
    kind: failure.kind,
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
  };
}

/** Failure → RETRYING or FAILED on the execution, and the matching event result. */
export async function failExecution(
  event: EventAge & { id: string; workspaceId: string; eventType: string; attempts: number },
  executionId: string,
  rawFailure: ClassifiedFailure
): Promise<HandlerResult> {
  const failure = capRateLimitAge(event, rawFailure);
  const final = !failure.retryable || (event.attempts >= TRIGGER_MAX_ATTEMPTS && failure.kind !== "rate_limit"); // hourly cap: wait, never drop (the sweep re-queues)
  await prisma.triggerExecution.update({
    where: { id: executionId },
    data: {
      status: final ? "FAILED" : "RETRYING",
      error: failure.userMessage,
      errorDetail: failure.technical,
      nextRetryAt: final ? null : new Date(Date.now() + backoffDelay(event.attempts, failure.kind, failure.retryAfterMs)),
    },
  });
  await recordBackendFailure(event, failure, final);
  if (final) return { status: "FAILED", error: failure.userMessage, errorDetail: failure.technical };
  return retrying(failure);
}

/** Nothing to send, by rule (limit reached, comment too old...). Ends the event. */
export async function skipExecution(executionId: string, error: string, errorDetail: string): Promise<HandlerResult> {
  await prisma.triggerExecution.update({
    where: { id: executionId },
    data: { status: "SKIPPED", error, errorDetail },
  });
  return { status: "PROCESSED", error };
}

export async function markExecutionSending(executionId: string) {
  return prisma.triggerExecution.update({
    where: { id: executionId },
    data: { status: "SENDING", attempts: { increment: 1 }, nextRetryAt: null },
  });
}

export async function markExecutionSent(executionId: string, sent: SentMessage, at = new Date()) {
  return prisma.triggerExecution.update({
    where: { id: executionId },
    data: {
      status: "SENT",
      sentAt: at,
      sentMessageId: sent.message_id ?? null,
      error: null,
      errorDetail: null,
      nextRetryAt: null,
    },
  });
}

/** A failure outside an execution (direct / follow-up sends): retry the event or give up. */
export async function eventFailure(
  event: EventAge & { id: string; workspaceId: string; eventType: string; attempts: number },
  rawFailure: ClassifiedFailure
): Promise<HandlerResult> {
  const failure = capRateLimitAge(event, rawFailure);
  const final = !failure.retryable || (event.attempts >= TRIGGER_MAX_ATTEMPTS && failure.kind !== "rate_limit"); // hourly cap: wait, never drop (the sweep re-queues)
  await recordBackendFailure(event, failure, final);
  if (final) return { status: "FAILED", error: failure.userMessage, errorDetail: failure.technical };
  return retrying(failure);
}
