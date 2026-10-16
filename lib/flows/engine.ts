/**
 * ETAP 6 — the flow engine's database-bound entry points (analysis §2.2).
 * The step loop itself is runner.ts (pure); the world it talks to is
 * effects.ts. This file loads a run, takes it (compare-and-swap), calls
 * `advance` and maps the result for the callers:
 *
 *   startFlowRun    a handler (comment / live / direct / mention) matched the
 *                   hidden proxy campaign of a published flow: create the run
 *                   (unique per execution, so a retried event never makes a
 *                   second one) and run it until it parks or ends
 *   resumeFlowRun   a tap (`fl:` payload), a typed answer or a timer wakes a
 *                   waiting run
 *   continueFlowRun the sweep continues a stuck ACTIVE run
 *   runDueFlowRuns  WAITING runs whose time has come (Delay, timeout, retry)
 *   sweepFlowRuns   cancellations, stuck runs, retention
 *
 * Taking a run = `updateMany({ id, seq, status: <waiting> } → ACTIVE)`; the
 * commit of every step is a CAS on the same seq (effects.commit). Two
 * workers can never both advance one run, and a crashed one is recovered by
 * the sweep or by the retry of the same event (`vars.__acq` remembers which
 * input took the run).
 */

import { flowGraphDraftSchema, triggerOf, type FlowGraph } from "./schema";
import { prisma } from "@/lib/db/client";
import type { FlowRun as FlowRunRow, Prisma } from "@/app/generated/prisma/client";
import { EXPIRED_REASON, isPrivateReplyExpired } from "@/lib/triggers/comment-handler";
import type { RecordedInteraction } from "@/lib/triggers/contacts";
import { skipExecution, type EventWithAccount, type HandlerResult } from "@/lib/triggers/delivery";
import { isWindowOpen, WINDOW_CLOSED_REASON } from "@/lib/triggers/followups";
import { LIVE_TOO_OLD_REASON, isLiveCommentTooOld } from "@/lib/triggers/live-handler";
import { isFlowsEnabled } from "./config";
import { createRealEffects, type RealEffectsInput } from "./effects";
import { buildIndex, type FlowIndex } from "./graph";
import {
  advance,
  MAX_RUN_AGE_MS,
  planSignal,
  TERMINAL_STATUSES,
  type AdvanceResult,
  type FlowRunState,
  type RunSignal,
  type RunStatusName,
  type WaitKind,
} from "./runner";

export { isFlowsEnabled } from "./config";

const LIVE_STATUSES: RunStatusName[] = ["ACTIVE", "WAITING_TAP", "WAITING_INBOUND", "WAITING_DELAY"];
const WAITING_STATUSES: RunStatusName[] = ["WAITING_TAP", "WAITING_INBOUND", "WAITING_DELAY"];
/** An ACTIVE run untouched this long lost its worker. */
export const STUCK_AFTER_MS = 10 * 60_000;
/** A cold comment run (private reply sent, button never tapped) older than this makes room for a new trigger. */
const COLD_RUN_MS = 24 * 3600_000;
export const FLOW_DELETED_REASON = "Oqim o'chirilgan yoki nashrdan olingan — bekor qilindi.";
export const SKIP_LIVE_RUN_REASON = "Mijozda faol oqim bor — yangi oqim boshlanmadi.";
export const STUCK_REASON = "Oqim qotib qoldi (10 daqiqa javobsiz) — to'xtatildi.";
const BAD_GRAPH_REASON = "Oqim grafi o'qilmadi — to'xtatildi.";

// ─── Loading ──────────────────────────────────────────────────────────────────

/** The pinned graph of a version. Lenient parse: a pinned version keeps running whatever the schema learns later. */
export function parseVersionGraph(raw: unknown): FlowGraph | null {
  const parsed = flowGraphDraftSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

type RunRow = FlowRunRow & {
  flow: { id: string; name: string; triggerType: string; status: string };
  version: { id: string; graph: unknown };
};

async function loadRun(runId: string): Promise<RunRow | null> {
  return (await prisma.flowRun.findUnique({
    where: { id: runId },
    include: { flow: true, version: true },
  })) as RunRow | null;
}

function toState(row: RunRow): FlowRunState {
  return {
    id: row.id,
    status: row.status as RunStatusName,
    triggerType: row.flow.triggerType as FlowRunState["triggerType"],
    currentNodeId: row.currentNodeId,
    seq: row.seq,
    vars: { ...obj(row.variables) },
    waitNodeId: row.waitNodeId,
    waitKind: (row.waitKind as WaitKind | null) ?? null,
    waitUntil: row.waitUntil,
    sendsSinceInbound: row.sendsSinceInbound,
    startedAt: row.startedAt,
    endReason: row.endReason,
    lastError: row.lastError,
    isTest: row.isTest,
  };
}

/** The world around a run (account, conversation, execution, comment) → the real effects port. */
async function effectsFor(row: RunRow) {
  const [account, event] = await Promise.all([
    prisma.instagramAccount.findUnique({ where: { id: row.instagramAccountId } }),
    prisma.instagramEvent.findUnique({ where: { id: row.eventId }, select: { messageId: true, eventType: true } }),
  ]);
  if (!account) return null;
  const input: RealEffectsInput = {
    workspaceId: row.workspaceId,
    flowId: row.flowId,
    flowName: row.flow.name,
    account,
    igUserId: row.igUserId,
    conversationId: row.conversationId,
    executionId: row.executionId,
    eventId: row.eventId,
    commentId: event && (event.eventType === "COMMENT" || event.eventType === "LIVE_COMMENT") ? event.messageId : null,
  };
  return createRealEffects(input);
}

async function failRun(row: RunRow, reason: string): Promise<void> {
  await prisma.flowRun.updateMany({
    where: { id: row.id, seq: row.seq, status: row.status },
    data: { status: "FAILED", endReason: reason, lastError: reason, waitUntil: null, waitNodeId: null, waitKind: null, finishedAt: new Date() },
  });
}

// ─── Live runs (thread ownership) ─────────────────────────────────────────────

/** The person's live run on the account, if any. At most one exists (start is serialised). */
export async function findLiveRun(instagramAccountId: string, igUserId: string) {
  return prisma.flowRun.findFirst({
    where: { instagramAccountId, igUserId, status: { in: LIVE_STATUSES } },
    orderBy: { startedAt: "desc" },
    select: { id: true, status: true, waitKind: true, waitNodeId: true, updatedAt: true },
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

export interface StartFlowInput {
  flow: { id: string; name: string; workspaceId: string };
  version: { id: string; graph: unknown };
  /** The proxy campaign that matched. */
  campaign: { id: string };
  event: EventWithAccount;
  interaction: RecordedInteraction;
  matchedKeyword: string | null;
}

function splitMatch(matched: string | null): { keyword: string | null; intent: string | null } {
  if (!matched) return { keyword: null, intent: null };
  const at = matched.indexOf(": ");
  if (at < 0) return { keyword: matched, intent: null };
  return { intent: matched.slice(0, at), keyword: matched.slice(at + 2) };
}

function mapAdvance(state: FlowRunState, result: AdvanceResult): HandlerResult {
  if (result.lost) return { status: "PROCESSED" };
  if (state.status === "FAILED") return { status: "FAILED", error: state.endReason ?? "Oqim bajarilmadi" };
  if (state.status === "CANCELLED") return { status: "PROCESSED", error: state.endReason ?? undefined };
  return { status: "PROCESSED" };
}

/**
 * Start (or continue after a retry) the run of a matched flow. Called by the
 * comment / live / direct / mention handlers with the event's recorded
 * interaction; returns the event's HandlerResult.
 */
export async function startFlowRun(input: StartFlowInput): Promise<HandlerResult> {
  const { event, campaign, interaction } = input;
  if (!isFlowsEnabled()) return { status: "IGNORED", error: "Oqimlar o'chirilgan (FLOWS_DISABLED)" };
  const account = event.instagramAccount;

  const graph = parseVersionGraph(input.version.graph);
  const trigger = graph ? triggerOf(graph) : null;
  if (!graph || !trigger) return { status: "FAILED", error: BAD_GRAPH_REASON };

  // The proxy execution: thread ownership, window anchors, idempotent first send.
  const key = { eventId_campaignId: { eventId: event.id, campaignId: campaign.id } };
  let execution = await prisma.triggerExecution.findUnique({ where: key });
  if (!execution) {
    try {
      execution = await prisma.triggerExecution.create({
        data: { workspaceId: event.workspaceId, eventId: event.id, campaignId: campaign.id, status: "PENDING", matchedKeyword: input.matchedKeyword, responseText: `(flow) ${input.flow.name}`.slice(0, 200) },
      });
    } catch (error) {
      if ((error as { code?: string })?.code !== "P2002") throw error;
      execution = await prisma.triggerExecution.findUniqueOrThrow({ where: key });
    }
  }

  // A retried event: the run exists already — continue it, never a second one.
  const existing = await prisma.flowRun.findUnique({ where: { executionId: execution.id } });
  if (existing) {
    const row = await loadRun(existing.id);
    if (!row) return { status: "PROCESSED" };
    if (row.status !== "ACTIVE") return { status: "PROCESSED" };
    const fx = await effectsFor(row);
    if (!fx) return { status: "FAILED", error: "Instagram akkaunt topilmadi" };
    const state = toState(row);
    const result = await advance(state, buildIndex(graph), fx);
    return mapAdvance(state, result);
  }
  if (execution.status === "SKIPPED" || execution.status === "FAILED") return { status: "PROCESSED" };

  // Hard rules before anything is created.
  const isComment = event.eventType === "COMMENT" || event.eventType === "LIVE_COMMENT";
  if (event.eventType === "COMMENT" && isPrivateReplyExpired(event.timestamp)) {
    return skipExecution(execution.id, EXPIRED_REASON, `comment at ${event.timestamp.toISOString()}`);
  }
  if (event.eventType === "LIVE_COMMENT" && isLiveCommentTooOld(event.timestamp)) {
    return skipExecution(execution.id, LIVE_TOO_OLD_REASON, `live comment at ${event.timestamp.toISOString()}`);
  }
  if (isComment) {
    // Meta allows one private reply per comment: production may have used it.
    const answered = await prisma.dmLog.findFirst({ where: { commentId: event.messageId, status: "SENT" }, select: { id: true } });
    if (answered) {
      return skipExecution(execution.id, "Bu izohga boshqa kampaniya allaqachon shaxsiy javob yuborgan.", `DmLog ${answered.id} SENT for comment ${event.messageId}`);
    }
  } else {
    // The person wrote first: the 24h window opens at their message.
    if (!execution.openedAt) {
      execution = await prisma.triggerExecution.update({ where: { id: execution.id }, data: { openedAt: event.timestamp, lastInboundAt: event.timestamp } });
    }
    if (!isWindowOpen(execution, new Date())) {
      return skipExecution(execution.id, WINDOW_CLOSED_REASON, `message at ${event.timestamp.toISOString()}`);
    }
  }

  const { keyword, intent } = splitMatch(input.matchedKeyword);
  const triggerSnapshot = {
    text: event.text,
    keyword,
    intent,
    source: event.referralSource === "ADS" ? "ADS" : event.ref ? "LINK" : "organic",
    mediaId: event.mediaId ?? null,
    audience: interaction.isNewContact ? "NEW" : "RETURNING",
  };

  // One live run per person: serialised with an advisory lock, like the DM claim.
  const lockKey = `${account.id}:${event.senderId}`;
  const outcome = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('flow-start'), hashtext(${lockKey}))`;
      const live = await tx.flowRun.findFirst({
        where: { instagramAccountId: account.id, igUserId: event.senderId, status: { in: LIVE_STATUSES } },
        orderBy: { startedAt: "desc" },
      });
      if (live) {
        const cold = live.status === "WAITING_TAP" && live.waitKind === "tap" && Date.now() - live.updatedAt.getTime() > COLD_RUN_MS;
        if (!cold) return { conflict: true as const };
        // The old button was never tapped and its window is long gone: the new trigger takes over.
        await tx.flowRun.updateMany({
          where: { id: live.id, seq: live.seq, status: live.status },
          data: { status: "CANCELLED", endReason: "Yangi trigger bilan almashtirildi (tugma bosilmagan).", waitUntil: null, finishedAt: new Date() },
        });
      }
      try {
        const run = await tx.flowRun.create({
          data: {
            workspaceId: event.workspaceId,
            flowId: input.flow.id,
            versionId: input.version.id,
            instagramAccountId: account.id,
            igUserId: event.senderId,
            contactId: interaction.contact.id,
            conversationId: interaction.conversation.id,
            eventId: event.id,
            executionId: execution!.id,
            status: "ACTIVE",
            currentNodeId: trigger.id,
            seq: 0,
            variables: { __trigger: triggerSnapshot } as Prisma.InputJsonValue,
            sendsSinceInbound: 0,
          },
        });
        return { conflict: false as const, run };
      } catch (error) {
        if ((error as { code?: string })?.code !== "P2002") throw error;
        const run = await tx.flowRun.findUnique({ where: { executionId: execution!.id } });
        if (!run) throw error;
        return { conflict: false as const, run };
      }
    },
    { maxWait: 5_000, timeout: 10_000 }
  );
  if (outcome.conflict) {
    return skipExecution(execution.id, SKIP_LIVE_RUN_REASON, `person ${event.senderId} has a live flow run`);
  }

  // DM-side runs: the execution is SENT from the start, so findActiveConversations
  // (thread ownership for JavobAI / Direct triggers) sees it. Comment runs mark it
  // SENT with the private reply itself.
  if (!isComment && execution.status !== "SENT") {
    await prisma.triggerExecution.update({ where: { id: execution.id }, data: { status: "SENT", sentAt: new Date(), error: null } });
  }

  const row = await loadRun(outcome.run.id);
  if (!row) return { status: "PROCESSED" };
  const fx = await effectsFor(row);
  if (!fx) return { status: "FAILED", error: "Instagram akkaunt topilmadi" };
  const state = toState(row);
  const result = await advance(state, buildIndex(graph), fx);
  return mapAdvance(state, result);
}

// ─── Resume ───────────────────────────────────────────────────────────────────

export type ResumeOutcome =
  | { status: "advanced"; run: FlowRunState; result: AdvanceResult }
  | { status: "ignored"; reason: string }
  | { status: "busy" }
  | { status: "stale" }
  | { status: "missing" }
  | { status: "disabled" };

/**
 * Wake a waiting run with a tap, a typed answer or a timer. The caller has
 * verified that the tap / message belongs to the run's person (bridge.ts).
 */
export async function resumeFlowRun(runId: string, signal: RunSignal, options: { expectedSeq?: number } = {}): Promise<ResumeOutcome> {
  if (!isFlowsEnabled()) return { status: "disabled" };
  const row = await loadRun(runId);
  if (!row) return { status: "missing" };
  const graph = parseVersionGraph(row.version.graph);
  if (!graph) {
    await failRun(row, BAD_GRAPH_REASON);
    return { status: "missing" };
  }
  const index: FlowIndex = buildIndex(graph);
  const state = toState(row);
  const now = new Date();
  const eventKey = signal.kind === "timer" ? `timer:${state.seq}` : signal.eventId;

  // A retry of the event that already took this run (a crash before the first commit).
  const retryOfSameEvent = state.status === "ACTIVE" && signal.kind !== "timer" && state.vars.__acq === eventKey;
  if (!retryOfSameEvent) {
    if (options.expectedSeq !== undefined && state.seq !== options.expectedSeq) return { status: "stale" };
    const plan = planSignal(state, index, signal, now);
    if (plan.kind === "ignore") {
      if (plan.touch && signal.kind !== "timer") {
        const fx = await effectsFor(row);
        await fx?.touchInbound(state, signal.at, { open: false, text: signal.text }).catch(() => {});
      }
      return { status: "ignored", reason: plan.reason };
    }
    const taken = await prisma.flowRun.updateMany({
      where: { id: row.id, seq: state.seq, status: state.status },
      data: { status: "ACTIVE", variables: { ...state.vars, __acq: eventKey } as Prisma.InputJsonValue },
    });
    if (taken.count !== 1) return { status: "busy" };
    state.status = "ACTIVE";
    state.vars.__acq = eventKey;
  }

  const fx = await effectsFor(row);
  if (!fx) {
    await failRun({ ...row, status: "ACTIVE" }, "Instagram akkaunt topilmadi");
    return { status: "missing" };
  }
  // The signal is applied only while the run still waits at its node.
  const result = await advance(state, index, fx, state.waitNodeId ? signal : undefined);
  return { status: "advanced", run: state, result };
}

/** Continue an ACTIVE run (the sweep): once, then FAILED. */
export async function continueFlowRun(runId: string): Promise<ResumeOutcome> {
  if (!isFlowsEnabled()) return { status: "disabled" };
  const row = await loadRun(runId);
  if (!row || row.status !== "ACTIVE") return { status: "missing" };
  const graph = parseVersionGraph(row.version.graph);
  if (!graph) {
    await failRun(row, BAD_GRAPH_REASON);
    return { status: "missing" };
  }
  const state = toState(row);
  if (Number(state.vars.__stuck) >= 1) {
    await failRun(row, STUCK_REASON);
    return { status: "ignored", reason: STUCK_REASON };
  }
  const marked = await prisma.flowRun.updateMany({
    where: { id: row.id, seq: state.seq, status: "ACTIVE" },
    data: { variables: { ...state.vars, __stuck: 1 } as Prisma.InputJsonValue },
  });
  if (marked.count !== 1) return { status: "busy" };
  state.vars.__stuck = 1;

  // It stopped while applying an input: put it back to waiting (the customer's retry / the timer re-delivers).
  if (state.waitNodeId && state.waitKind) {
    const status: RunStatusName =
      state.waitKind === "tap" || state.waitKind === "choice" || state.waitKind === "phone"
        ? "WAITING_TAP"
        : state.waitKind === "inbound" || state.waitKind === "reopen"
          ? "WAITING_INBOUND"
          : "WAITING_DELAY";
    await prisma.flowRun.updateMany({
      where: { id: row.id, seq: state.seq, status: "ACTIVE" },
      data: { status, ...(status === "WAITING_DELAY" ? { waitUntil: new Date() } : {}) },
    });
    return { status: "ignored", reason: "Kutish holatiga qaytarildi" };
  }
  const fx = await effectsFor(row);
  if (!fx) {
    await failRun(row, "Instagram akkaunt topilmadi");
    return { status: "missing" };
  }
  const result = await advance(state, buildIndex(graph), fx);
  return { status: "advanced", run: state, result };
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

/** WAITING runs whose wait is over (Delay, button timeout, retry after a failed send) → resume. */
export async function runDueFlowRuns(now: Date = new Date(), limit = 100): Promise<{ resumed: number; failed: number }> {
  if (!isFlowsEnabled()) return { resumed: 0, failed: 0 };
  const due = await prisma.flowRun.findMany({
    where: { status: { in: WAITING_STATUSES }, waitUntil: { not: null, lte: now } },
    select: { id: true, seq: true },
    orderBy: { waitUntil: "asc" },
    take: limit,
  });
  let resumed = 0;
  let failed = 0;
  for (const run of due) {
    try {
      const outcome = await resumeFlowRun(run.id, { kind: "timer" }, { expectedSeq: run.seq });
      if (outcome.status === "advanced") resumed++;
    } catch (error) {
      failed++;
      console.error(`[Flows] due run ${run.id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return { resumed, failed };
}

const RETENTION_DAYS = () => Math.max(7, Number(process.env.FLOW_RUN_RETENTION_DAYS) || 90);

/**
 * Cancellations and clean-up (decision 5 / max run age / retention):
 *   - WAITING runs of an unpublished or archived flow → CANCELLED;
 *   - runs older than 7 days → CANCELLED;
 *   - ACTIVE runs untouched for 10 minutes → continued once, then FAILED;
 *   - finished runs older than FLOW_RUN_RETENTION_DAYS (90) → deleted with their steps.
 */
export async function sweepFlowRuns(now: Date = new Date()): Promise<{ cancelledFlow: number; cancelledAge: number; stuck: number; deleted: number }> {
  const out = { cancelledFlow: 0, cancelledAge: 0, stuck: 0, deleted: 0 };
  if (!isFlowsEnabled()) return out;
  const cancel = async (rows: Array<{ id: string; seq: number; status: string }>, reason: string) => {
    let count = 0;
    for (const run of rows) {
      const done = await prisma.flowRun.updateMany({
        where: { id: run.id, seq: run.seq, status: run.status as RunStatusName },
        data: { status: "CANCELLED", endReason: reason, waitUntil: null, waitNodeId: null, waitKind: null, finishedAt: now },
      });
      count += done.count;
    }
    return count;
  };

  const unpublished = await prisma.flowRun.findMany({
    where: { status: { in: WAITING_STATUSES }, flow: { status: { not: "PUBLISHED" } } },
    select: { id: true, seq: true, status: true },
    take: 200,
  });
  out.cancelledFlow = await cancel(unpublished, FLOW_DELETED_REASON);

  const old = await prisma.flowRun.findMany({
    where: { status: { in: WAITING_STATUSES }, startedAt: { lt: new Date(now.getTime() - MAX_RUN_AGE_MS) } },
    select: { id: true, seq: true, status: true },
    take: 200,
  });
  out.cancelledAge = await cancel(old, "Oqim muddati tugadi (7 kun) — bekor qilindi.");

  const stuck = await prisma.flowRun.findMany({
    where: { status: "ACTIVE", updatedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) } },
    select: { id: true, seq: true },
    take: 50,
  });
  for (const run of stuck) {
    try {
      const outcome = await continueFlowRun(run.id);
      if (outcome.status !== "missing") out.stuck++;
    } catch (error) {
      console.error(`[Flows] stuck run ${run.id} failed:`, error instanceof Error ? error.message : error);
    }
  }

  const cutoff = new Date(now.getTime() - RETENTION_DAYS() * 24 * 3600_000);
  const deleted = await prisma.flowRun.deleteMany({ where: { status: { in: [...TERMINAL_STATUSES] }, finishedAt: { not: null, lt: cutoff } } });
  out.deleted = deleted.count;
  return out;
}
