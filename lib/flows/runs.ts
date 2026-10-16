/**
 * ETAP 6 — the Runs tab's data (list, detail with steps, cancel) and the
 * per-flow statistics (runs by status, per-node visit counts from
 * FlowRunStep, completion rate). Every query is scoped by workspaceId; a run
 * of another workspace reads as 404. Failures throw FlowServiceError (the
 * service layer's `run()` maps it to the API's ServiceResult).
 */

import { prisma } from "@/lib/db/client";
import { notFound } from "./errors";
import { TERMINAL_STATUSES, type RunStatusName } from "./runner";

export const RUN_NOT_FOUND = "Ishga tushish yozuvi topilmadi";
export const RUN_ALREADY_FINISHED = "Bu oqim allaqachon tugagan";
export const RUN_CANCELLED_BY_USER = "Qo'lda bekor qilindi";

const RUN_STATUSES: RunStatusName[] = ["ACTIVE", "WAITING_TAP", "WAITING_INBOUND", "WAITING_DELAY", "DONE", "FAILED", "CANCELLED"];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** Runs read for the statistics (newest first); older ones are not counted. */
const STATS_RUN_CAP = 5000;

export interface ListRunsOptions {
  flowId?: string;
  status?: RunStatusName;
  /** The id of the last row of the previous page. */
  cursor?: string;
  limit?: number;
}

export async function listRuns(workspaceId: string, options: ListRunsOptions = {}) {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const status = options.status && RUN_STATUSES.includes(options.status) ? options.status : undefined;
  const rows = await prisma.flowRun.findMany({
    where: { workspaceId, ...(options.flowId ? { flowId: options.flowId } : {}), ...(status ? { status } : {}) },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    take: limit + 1,
    include: { flow: { select: { name: true } }, version: { select: { version: true } } },
  });
  const page = rows.slice(0, limit);
  return {
    runs: page.map((row) => {
      const { flow, version, ...run } = row;
      delete (run as { variables?: unknown }).variables; // the list never carries the variables
      return { ...run, flowName: flow?.name ?? null, version: version?.version ?? null };
    }),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

/** One run with its steps (the full trace) and the visible variables. */
export async function getRun(workspaceId: string, runId: string) {
  const run = await prisma.flowRun.findFirst({
    where: { id: runId, workspaceId },
    include: { flow: { select: { name: true } }, version: { select: { version: true } } },
  });
  if (!run) throw notFound(RUN_NOT_FOUND);
  const steps = await prisma.flowRunStep.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
  const { flow, version, variables, ...rest } = run;
  const vars: Record<string, unknown> = {};
  for (const [key, value] of Object.entries((variables && typeof variables === "object" ? variables : {}) as Record<string, unknown>)) {
    if (!key.startsWith("__")) vars[key] = value;
  }
  return { ...rest, flowName: flow?.name ?? null, version: version?.version ?? null, variables: vars, steps };
}

/**
 * Cancel a live run (any state). The compare-and-swap on the status means a
 * run that moved meanwhile is re-read once; a step that was mid-flight loses
 * its own commit (status no longer ACTIVE) and stops quietly.
 */
export async function cancelRun(workspaceId: string, runId: string, reason: string = RUN_CANCELLED_BY_USER) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const run = await prisma.flowRun.findFirst({ where: { id: runId, workspaceId } });
    if (!run) throw notFound(RUN_NOT_FOUND);
    if (TERMINAL_STATUSES.has(run.status as RunStatusName)) return { id: run.id, status: run.status, alreadyFinished: true };
    const done = await prisma.flowRun.updateMany({
      where: { id: run.id, workspaceId, status: run.status },
      data: { status: "CANCELLED", endReason: reason.slice(0, 200), waitUntil: null, waitNodeId: null, waitKind: null, finishedAt: new Date() },
    });
    if (done.count === 1) return { id: run.id, status: "CANCELLED" as const, alreadyFinished: false };
  }
  return { id: runId, status: "CANCELLED" as const, alreadyFinished: false };
}

export interface FlowStats {
  flowId: string;
  total: number;
  byStatus: Record<string, number>;
  /** Visits per node id (every committed step counts; a node that waits and resumes counts twice). */
  nodes: Array<{ nodeId: string; nodeType: string; visits: number; failed: number; skipped: number }>;
  /** DONE / (DONE + FAILED + CANCELLED), 0..1; null while nothing finished. */
  completionRate: number | null;
  /** True when more than STATS_RUN_CAP runs exist and only the newest were counted. */
  truncated: boolean;
}

export async function flowStats(workspaceId: string, flowId: string): Promise<FlowStats> {
  const flow = await prisma.flow.findFirst({ where: { id: flowId, workspaceId }, select: { id: true } });
  if (!flow) throw notFound("Oqim topilmadi");
  const runs = await prisma.flowRun.findMany({
    where: { workspaceId, flowId },
    orderBy: { startedAt: "desc" },
    take: STATS_RUN_CAP + 1,
    select: { id: true, status: true },
  });
  const truncated = runs.length > STATS_RUN_CAP;
  const counted = runs.slice(0, STATS_RUN_CAP);

  const byStatus: Record<string, number> = {};
  for (const run of counted) byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;

  const nodes = new Map<string, { nodeId: string; nodeType: string; visits: number; failed: number; skipped: number }>();
  if (counted.length > 0) {
    const steps = await prisma.flowRunStep.findMany({
      where: { runId: { in: counted.map((run) => run.id) } },
      select: { nodeId: true, nodeType: true, status: true },
    });
    for (const step of steps) {
      const entry = nodes.get(step.nodeId) ?? { nodeId: step.nodeId, nodeType: step.nodeType, visits: 0, failed: 0, skipped: 0 };
      entry.visits++;
      if (step.status === "FAILED") entry.failed++;
      if (step.status === "SKIPPED") entry.skipped++;
      nodes.set(step.nodeId, entry);
    }
  }

  const finished = (byStatus.DONE ?? 0) + (byStatus.FAILED ?? 0) + (byStatus.CANCELLED ?? 0);
  return {
    flowId,
    total: counted.length,
    byStatus,
    nodes: [...nodes.values()].sort((a, b) => b.visits - a.visits || a.nodeId.localeCompare(b.nodeId)),
    completionRate: finished > 0 ? (byStatus.DONE ?? 0) / finished : null,
    truncated,
  };
}
