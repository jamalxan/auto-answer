/**
 * Follow-up engine (TZ 13) for Comment 2.0 campaigns.
 *
 * Each campaign has up to a few TriggerFollowUpSteps (delay + condition +
 * text). When an execution reaches the right moment, one TriggerFollowUpRun
 * per step is created (unique per execution + step, so never twice), due at
 * anchor + delay. A sweep in the trigger worker (every minute) sends what is
 * due — or records why not.
 *
 * When steps are scheduled:
 *   - campaign with an opening button: ALWAYS / NO_REPLY steps when the person
 *     taps it (anchor = tap); NO_CLICK steps when the private reply goes out
 *     (anchor = send) — they are about *not* tapping.
 *   - campaign without a button: every step when the private reply goes out.
 *
 * Meta lets the conversation continue only inside the 24-hour window that the
 * person's last message (or button tap) opened. A step whose window is closed
 * — or was never opened, e.g. a NO_CLICK step for someone who neither tapped
 * nor wrote — is SKIPPED with the reason, never forced.
 *
 * Retries: a retryable send failure puts the run back to SCHEDULED five
 * minutes later, at most FOLLOW_UP_MAX_TRIES tries in total. The run has no
 * attempts column, so the try number is kept at the start of `reason`
 * ("Qayta urinish 2/3: …") and read back by followUpAttempt().
 */

import { prisma } from "@/lib/db/client";
import { sendDirectMessage } from "@/lib/meta/client";
import type { TriggerFollowUpCondition } from "@/app/generated/prisma/client";
import { isTriggerEngineEnabled } from "./config";
import { storeMessage } from "./contacts";
import { readAccessToken, recordBackendFailure, sendGuarded } from "./delivery";

export const MESSAGING_WINDOW_MS = 24 * 3600_000;
/** A send this close to the window's end may arrive after it closed. */
export const WINDOW_SAFETY_MS = 5 * 60_000;
export const FOLLOW_UP_MAX_TRIES = 3;
export const FOLLOW_UP_RETRY_DELAY_MS = 5 * 60_000;
const SENDING_LEASE_MS = 10 * 60_000;
const SWEEP_BATCH = 50;

export const WINDOW_CLOSED_REASON = "24 soatlik oyna yopilgan — Instagram endi yozishga ruxsat bermaydi.";

// ─── Pure rules ───────────────────────────────────────────────────────────────

export interface WindowState {
  openedAt: Date | null;
  lastInboundAt: Date | null;
}

/** The person's last sign of life in this thread: their last message or button tap. */
export function windowAnchor(state: WindowState): Date | null {
  const times = [state.openedAt, state.lastInboundAt].filter((d): d is Date => d instanceof Date);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

/** True while a message to the person is still inside Meta's 24-hour window (with margin). */
export function isWindowOpen(state: WindowState, now: Date): boolean {
  const anchor = windowAnchor(state);
  if (!anchor) return false;
  return now.getTime() - anchor.getTime() < MESSAGING_WINDOW_MS - WINDOW_SAFETY_MS;
}

export interface FollowUpExecutionState extends WindowState {
  stoppedAt: Date | null;
  stopReason: string | null;
  sentAt: Date | null;
}

export type FollowUpDecision =
  | { action: "send" }
  | { action: "cancel"; reason: string }
  | { action: "skip"; reason: string };

export function decideFollowUp(input: {
  now: Date;
  condition: TriggerFollowUpCondition;
  execution: FollowUpExecutionState;
}): FollowUpDecision {
  const { now, condition, execution } = input;
  if (execution.stoppedAt) {
    return { action: "cancel", reason: execution.stopReason ?? "Follow-up to'xtatilgan" };
  }

  if (condition === "NO_REPLY") {
    // The trigger moment is the tap (or the private reply without a button);
    // the tap itself also sets lastInboundAt, so only a later message counts.
    const trigger = execution.openedAt ?? execution.sentAt;
    if (execution.lastInboundAt && (!trigger || execution.lastInboundAt.getTime() > trigger.getTime())) {
      return { action: "skip", reason: "Mijoz javob yozgan — shart (javob yo'q) bajarilmadi." };
    }
  }
  if (condition === "NO_CLICK" && execution.openedAt) {
    return { action: "skip", reason: "Mijoz tugmani bosgan — shart (bosmagan) bajarilmadi." };
  }

  if (!isWindowOpen(execution, now)) return { action: "skip", reason: WINDOW_CLOSED_REASON };
  return { action: "send" };
}

/** Which try the next send of this run is (1-based), from the reason prefix. */
export function followUpAttempt(reason: string | null | undefined): number {
  const match = /^Qayta urinish (\d+)\//.exec(reason ?? "");
  return match ? Number(match[1]) : 1;
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

export type ScheduleMoment = "sent" | "opened";

/** Steps that belong to this moment (see the header). */
export function stepsForMoment<S extends { condition: TriggerFollowUpCondition }>(
  steps: S[],
  hasOpeningButton: boolean,
  moment: ScheduleMoment
): S[] {
  if (!hasOpeningButton) return moment === "sent" ? steps : [];
  return steps.filter((step) => (moment === "sent") === (step.condition === "NO_CLICK"));
}

export async function scheduleFollowUps(
  execution: { id: string; workspaceId: string },
  campaign: { id: string; openingButtonLabel: string | null },
  anchor: Date,
  moment: ScheduleMoment = "opened"
): Promise<number> {
  const steps = await prisma.triggerFollowUpStep.findMany({
    where: { campaignId: campaign.id },
    orderBy: [{ sort: "asc" }, { createdAt: "asc" }],
  });
  const existing = await prisma.triggerFollowUpRun.findMany({
    where: { executionId: execution.id },
    select: { stepId: true },
  });
  const scheduled = new Set(existing.map((run) => run.stepId));
  const due = stepsForMoment(steps, Boolean(campaign.openingButtonLabel), moment).filter(
    (step) => !scheduled.has(step.id)
  );
  if (due.length === 0) return 0;

  const result = await prisma.triggerFollowUpRun.createMany({
    data: due.map((step) => ({
      workspaceId: execution.workspaceId,
      executionId: execution.id,
      stepId: step.id,
      status: "SCHEDULED" as const,
      scheduledAt: new Date(anchor.getTime() + Math.max(0, step.delayMinutes) * 60_000),
    })),
    // A retried event or a second tap must not schedule the same step again.
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * Stop an execution's automation: every SCHEDULED follow-up is CANCELLED and
 * the execution remembers why (stop on reply / lead / handoff / manual).
 * Returns how many runs were cancelled.
 */
export async function cancelFollowUps(workspaceId: string, executionId: string, reason: string): Promise<number> {
  const now = new Date();
  const stopped = await prisma.triggerExecution.updateMany({
    where: { id: executionId, workspaceId, stoppedAt: null },
    data: { stoppedAt: now, stopReason: reason },
  });
  const owned =
    stopped.count > 0 ||
    (await prisma.triggerExecution.count({ where: { id: executionId, workspaceId } })) > 0;
  if (!owned) return 0;

  const cancelled = await prisma.triggerFollowUpRun.updateMany({
    where: { executionId, workspaceId, status: "SCHEDULED" },
    data: { status: "CANCELLED", reason },
  });
  return cancelled.count;
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

export interface FollowUpSweepResult {
  sent: number;
  skipped: number;
  cancelled: number;
  failed: number;
  retried: number;
}

async function finishRun(id: string, status: "SENT" | "SKIPPED" | "CANCELLED" | "FAILED", reason: string | null, sentAt?: Date) {
  await prisma.triggerFollowUpRun.update({
    where: { id },
    data: { status, reason, ...(sentAt ? { sentAt } : {}) },
  });
}

/** Claims and handles every follow-up that is due. Never throws per run. */
export async function runDueFollowUps(now: Date = new Date()): Promise<FollowUpSweepResult> {
  const result: FollowUpSweepResult = { sent: 0, skipped: 0, cancelled: 0, failed: 0, retried: 0 };
  if (!isTriggerEngineEnabled()) return result;

  // A run left in SENDING by a crashed worker may or may not have gone out.
  await prisma.triggerFollowUpRun.updateMany({
    where: { status: "SENDING", updatedAt: { lt: new Date(now.getTime() - SENDING_LEASE_MS) } },
    data: { status: "FAILED", reason: "Yuborish jarayoni uzildi — ikki marta yubormaslik uchun qayta yuborilmadi." },
  });

  const due = await prisma.triggerFollowUpRun.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: SWEEP_BATCH,
    select: { id: true },
  });

  for (const { id } of due) {
    const claimed = await prisma.triggerFollowUpRun.updateMany({
      where: { id, status: "SCHEDULED" },
      data: { status: "SENDING" },
    });
    if (claimed.count === 0) continue; // another worker took it

    try {
      const outcome = await processRun(id, now);
      result[outcome]++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Trigger Engine] follow-up ${id} failed:`, message);
      await finishRun(id, "FAILED", `Ichki xatolik: ${message}`.slice(0, 500)).catch(() => {});
      result.failed++;
    }
  }
  return result;
}

async function processRun(runId: string, now: Date): Promise<keyof FollowUpSweepResult> {
  const run = await prisma.triggerFollowUpRun.findUnique({ where: { id: runId } });
  if (!run) return "cancelled";
  const [step, execution] = await Promise.all([
    prisma.triggerFollowUpStep.findUnique({ where: { id: run.stepId } }),
    prisma.triggerExecution.findUnique({
      where: { id: run.executionId },
      include: { campaign: true, event: { include: { instagramAccount: true } } },
    }),
  ]);
  if (!step || !execution) {
    await finishRun(runId, "CANCELLED", "Qadam yoki ijro o'chirilgan.");
    return "cancelled";
  }
  if (!execution.campaign.active) {
    await finishRun(runId, "CANCELLED", "Kampaniya o'chirilgan (faol emas).");
    return "cancelled";
  }

  const decision = decideFollowUp({ now, condition: step.condition, execution });
  if (decision.action === "cancel") {
    await finishRun(runId, "CANCELLED", decision.reason);
    return "cancelled";
  }
  if (decision.action === "skip") {
    await finishRun(runId, "SKIPPED", decision.reason);
    return "skipped";
  }

  const event = execution.event;
  const account = event.instagramAccount;
  const token = readAccessToken(account);
  if (!token.ok) {
    await finishRun(runId, "FAILED", token.failure.userMessage);
    return "failed";
  }

  const send = await sendGuarded(run.workspaceId, account, () =>
    sendDirectMessage(token.token, account.instagramId, event.senderId, step.message)
  );
  if (send.ok) {
    const sentAt = new Date();
    await finishRun(runId, "SENT", null, sentAt);
    if (event.conversationId) {
      await storeMessage({
        conversationId: event.conversationId,
        direction: "OUTBOUND",
        text: step.message,
        mid: send.sent.message_id ?? null,
        executionId: execution.id,
      }).catch(() => {});
    }
    return "sent";
  }
  if (send.skipped) {
    await finishRun(runId, "SKIPPED", send.error);
    return "skipped";
  }

  const attempt = followUpAttempt(run.reason);
  const retry = send.failure.retryable && attempt < FOLLOW_UP_MAX_TRIES;
  await recordBackendFailure(
    { id: event.id, workspaceId: run.workspaceId, eventType: "FOLLOW_UP" },
    send.failure,
    !retry
  );
  if (retry) {
    await prisma.triggerFollowUpRun.update({
      where: { id: runId },
      data: {
        status: "SCHEDULED",
        scheduledAt: new Date(now.getTime() + FOLLOW_UP_RETRY_DELAY_MS),
        reason: `Qayta urinish ${attempt + 1}/${FOLLOW_UP_MAX_TRIES}: ${send.failure.userMessage}`.slice(0, 500),
      },
    });
    return "retried";
  }
  await finishRun(runId, "FAILED", send.failure.userMessage);
  return "failed";
}
