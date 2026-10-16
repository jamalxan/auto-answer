/**
 * ETAP 6 — the seam between the trigger engine and the flow engine
 * (analysis §2.1). A published flow owns a hidden proxy `TriggerCampaign`
 * (kind FLOW); the webhook's single claim / matching decision stays the only
 * one. This module is what the small flow branches in lib/triggers call:
 *
 *   - `startFlowFromCampaign`   the comment / live / direct / mention handler
 *                               selected a FLOW campaign → start the run
 *   - `handleFlowTap`           an `fl:<run>:<node>:<button>` payload → resume
 *   - `handleFlowInbound`       a plain DM from someone whose run waits for an
 *                               answer → resume (the handler half of the claim)
 *   - `findConsumingRun`        the claim half: the webhook keeps those DMs
 *                               away from production, JavobAI and the Direct
 *                               triggers (ingest.ts findClaimedFlowMessages)
 *   - `flowOwnsThread`          any live run blocks other DM triggers
 *
 * Two-sided rules (a claim without a handler = an unanswered message, a
 * handler without a claim = two answers) use the SAME `consumesPlainText`
 * predicate from runner.ts on both sides.
 *
 * Light on purpose: claim.ts, ingest.ts and the production webhook load it.
 * The engine (Meta client, effects) is imported lazily, only when a flow
 * actually starts or resumes. With FLOWS_DISABLED=1 every function answers
 * "no flow" and production behaves as before.
 */

import { prisma } from "@/lib/db/client";
import type { TriggerCampaign } from "@/app/generated/prisma/client";
import type { EventWithAccount, HandlerResult } from "@/lib/triggers/delivery";
import type { RecordedInteraction } from "@/lib/triggers/contacts";
import { FLOW_PAYLOAD_PREFIX, isFlowsEnabled } from "./config";
import { consumesPlainText } from "./runner";

export { FLOW_PAYLOAD_PREFIX, isFlowPayload, isFlowsEnabled } from "./config";

export const FLOW_OWNS_THREAD_REASON = "Oqim (Flow) suhbati davom etmoqda — Direct trigger javob bermadi (ikki bot bir vaqtda yozmaydi).";
export const FLOW_TAP_FOREIGN_REASON = "Tugma bu odamga yoki akkauntga tegishli emas";
const LIVE_STATUSES = ["ACTIVE", "WAITING_TAP", "WAITING_INBOUND", "WAITING_DELAY"] as const;

// ─── Payload ──────────────────────────────────────────────────────────────────

export interface FlowTapPayload {
  runId: string;
  nodeId: string;
  buttonId: string;
}

export function parseFlowPayload(payload: string | null | undefined): FlowTapPayload | null {
  if (!payload || !payload.startsWith(FLOW_PAYLOAD_PREFIX)) return null;
  const parts = payload.slice(FLOW_PAYLOAD_PREFIX.length).split(":");
  const [runId, nodeId, ...rest] = parts;
  const buttonId = rest.join(":");
  if (!runId || !nodeId || !buttonId) return null;
  return { runId, nodeId, buttonId };
}

// ─── Published flows ──────────────────────────────────────────────────────────

/** The published flow behind a proxy campaign, with its pinned version; null for ordinary campaigns. */
export async function publishedFlowForCampaign(campaign: Pick<TriggerCampaign, "id"> & { kind?: string | null }) {
  if (campaign.kind !== "FLOW" || !isFlowsEnabled()) return null;
  const flow = await prisma.flow.findFirst({ where: { proxyCampaignId: campaign.id, status: "PUBLISHED" } });
  if (!flow || !flow.publishedVersionId) return null;
  const version = await prisma.flowVersion.findUnique({ where: { id: flow.publishedVersionId } });
  return version ? { flow, version } : null;
}

const NOT_PUBLISHED_REASON = "Oqim nashrdan olingan — javob yuborilmadi.";

/**
 * A handler selected `campaign` (kind FLOW): run the flow instead of sending
 * the campaign's own message. The execution row is created by the engine, so
 * thread ownership and dedup keep working exactly as for ordinary campaigns.
 */
export async function startFlowFromCampaign(
  event: EventWithAccount,
  campaign: TriggerCampaign,
  interaction: RecordedInteraction,
  matchedKeyword: string | null
): Promise<HandlerResult> {
  const published = await publishedFlowForCampaign(campaign);
  if (!published) return { status: "IGNORED", error: isFlowsEnabled() ? NOT_PUBLISHED_REASON : "Oqimlar o'chirilgan (FLOWS_DISABLED)" };
  const { startFlowRun } = await import("./engine");
  return startFlowRun({
    flow: { id: published.flow.id, name: published.flow.name, workspaceId: published.flow.workspaceId },
    version: { id: published.version.id, graph: published.version.graph },
    campaign: { id: campaign.id },
    event,
    interaction,
    matchedKeyword,
  });
}

// ─── Thread ownership ─────────────────────────────────────────────────────────

/** Any live run of the person blocks other DM triggers (one conversation, one bot). */
export async function flowOwnsThread(instagramAccountId: string, igUserId: string, db: Pick<typeof prisma, "flowRun"> = prisma): Promise<boolean> {
  if (!isFlowsEnabled()) return false;
  const run = await db.flowRun.findFirst({
    where: { instagramAccountId, igUserId, status: { in: [...LIVE_STATUSES] } },
    select: { id: true },
  });
  return run !== null;
}

/**
 * The person's run that waits for (and consumes) a plain typed message: an AI
 * ask, a button node's chips, a reopen wait — or one that is mid-step. A run
 * waiting for the tap of a message button does NOT consume text.
 */
export async function findConsumingRun(instagramAccountId: string, igUserId: string) {
  if (!isFlowsEnabled()) return null;
  const runs = await prisma.flowRun.findMany({
    where: { instagramAccountId, igUserId, status: { in: ["ACTIVE", "WAITING_INBOUND", "WAITING_TAP"] } },
    select: { id: true, status: true, waitKind: true },
    orderBy: { startedAt: "desc" },
    take: 3,
  });
  return runs.find((run) => consumesPlainText({ status: run.status, waitKind: run.waitKind as never })) ?? null;
}

// ─── Handler halves ───────────────────────────────────────────────────────────

/** A tap (`fl:` postback / quick reply) → resume the run, after checking it comes from the run's person. */
export async function handleFlowTap(event: EventWithAccount): Promise<HandlerResult> {
  const parsed = parseFlowPayload(event.payload);
  if (!parsed) return { status: "IGNORED", error: "Tugma noto'g'ri formatda" };
  const run = await prisma.flowRun.findFirst({
    where: { id: parsed.runId, workspaceId: event.workspaceId },
    select: { id: true, instagramAccountId: true, igUserId: true },
  });
  // The payload is ours, but the tap must come from the person we wrote to, on the same account.
  if (!run || run.instagramAccountId !== event.instagramAccountId || run.igUserId !== event.senderId) {
    return { status: "IGNORED", error: FLOW_TAP_FOREIGN_REASON };
  }
  const { resumeFlowRun } = await import("./engine");
  const outcome = await resumeFlowRun(run.id, {
    kind: "tap",
    nodeId: parsed.nodeId,
    buttonId: parsed.buttonId,
    eventId: event.id,
    at: event.timestamp,
    text: event.text,
  });
  return mapResume(outcome);
}

/** A plain DM from someone whose run waits for an answer → resume; null = no such run (not ours). */
export async function handleFlowInbound(event: EventWithAccount): Promise<HandlerResult | null> {
  if (event.payload) return null;
  const run = await findConsumingRun(event.instagramAccountId, event.senderId);
  if (!run) return null;
  const { resumeFlowRun } = await import("./engine");
  const outcome = await resumeFlowRun(run.id, { kind: "inbound", text: event.text, eventId: event.id, at: event.timestamp });
  return mapResume(outcome);
}

function mapResume(outcome: Awaited<ReturnType<typeof import("./engine").resumeFlowRun>>): HandlerResult {
  switch (outcome.status) {
    case "advanced":
      if (outcome.run.status === "FAILED") return { status: "PROCESSED", error: outcome.run.endReason ?? undefined };
      return { status: "PROCESSED" };
    case "ignored":
      return { status: "PROCESSED", error: outcome.reason };
    case "busy":
    case "stale":
      return { status: "PROCESSED", error: "Oqim hozir band — xabar qayd etildi." };
    case "missing":
      return { status: "IGNORED", error: "Oqim topilmadi" };
    case "disabled":
      return { status: "IGNORED", error: "Oqimlar o'chirilgan (FLOWS_DISABLED)" };
  }
}
