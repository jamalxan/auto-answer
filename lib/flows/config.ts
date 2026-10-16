/**
 * ETAP 6 — Flow Builder runtime switch. Kept apart from queue.ts (BullMQ) so
 * the trigger engine's hot paths (claim, normalize, handlers) can read it
 * without loading the queue client.
 *
 * FLOWS_DISABLED=1 is the kill switch: no flow branch executes, the hidden
 * proxy campaigns (kind FLOW) are treated as non-matching everywhere, `fl:`
 * payloads are not ours and the worker stays off — production and the
 * Comment 2.0 / Direct campaigns behave exactly as before flows existed.
 */

export function isFlowsEnabled(): boolean {
  const flag = (process.env.FLOWS_DISABLED ?? "").trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}

/**
 * Prisma `where` fragment for the campaign loaders of the trigger engine:
 * with flows off the proxy rows are invisible, so nothing can match them.
 */
export function flowKindFilter(): { kind?: "CAMPAIGN" } {
  return isFlowsEnabled() ? {} : { kind: "CAMPAIGN" };
}

export const FLOW_PAYLOAD_PREFIX = "fl:";

/**
 * A flow's own button / quick-reply payload (`fl:<runId>:<nodeId>:<buttonId>`).
 * Pure and env-aware so normalize.ts / claim.ts can use it: with flows off the
 * payload is not ours and falls through to production as before.
 */
export function isFlowPayload(payload: string | null | undefined): payload is string {
  return typeof payload === "string" && payload.startsWith(FLOW_PAYLOAD_PREFIX) && isFlowsEnabled();
}
