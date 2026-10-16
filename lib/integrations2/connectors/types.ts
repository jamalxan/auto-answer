/**
 * ETAP 8 — the contract between the delivery engine (deliver.ts) and a
 * connector. A connector gets the frozen payload and reports one of five
 * outcomes; it may also throw (`IntegrationAuthError` → auth, anything else
 * → retry), so a connector never touches `OutboundDelivery` itself.
 *
 *   sent   → SENT
 *   retry  → FAILED + next attempt on the retry schedule (or `retryAfterMs`)
 *   wait   → rescheduled after `delayMs` WITHOUT counting an attempt (enrichment waiting for the lead push)
 *   dead   → DEAD at once (non-retryable); `disableSubscription` also switches the subscription off (410)
 *   auth   → integration BROKEN, delivery held until it is repaired
 *   skipped→ SKIPPED (nothing to do: the connector's feature is switched off, the card does not apply)
 */

import type { Integration } from "@/app/generated/prisma/client";
import type { OutboundEventType } from "../config";
import type { OutboundPayloadV1 } from "../events";
import type { SubscriptionFilter } from "../subscriptions";

export interface SendContext {
  integration: Integration;
  delivery: { id: string; attempts: number; createdAt: Date };
  event: { id: string; type: OutboundEventType; workspaceId: string };
  /** The frozen payload, transcript already stripped unless the subscription asked for it. */
  payload: OutboundPayloadV1;
  filter: SubscriptionFilter;
}

interface Common {
  note?: string;
  responseCode?: number | null;
  responseSnippet?: string | null;
  signature?: string | null;
  externalId?: string | null;
  externalUrl?: string | null;
  durationMs?: number | null;
}

export type ConnectorResult =
  | (Common & { outcome: "sent" })
  | (Common & { outcome: "retry"; note: string; retryAfterMs?: number })
  | (Common & { outcome: "wait"; note: string; delayMs: number })
  | (Common & { outcome: "dead"; note: string; disableSubscription?: boolean })
  | (Common & { outcome: "auth"; note: string })
  | (Common & { outcome: "skipped"; note: string });

export interface ConnectionCheckResult {
  ok: boolean;
  reason?: "auth" | "error";
  message?: string;
}

export interface OutboundConnector {
  /** Event types this connector accepts a subscription for. */
  supports(type: OutboundEventType): boolean;
  send(context: SendContext): Promise<ConnectorResult>;
  /** Cheap, real health check for the "Test connection" button (no event sent). */
  check(integration: Integration): Promise<ConnectionCheckResult>;
}
