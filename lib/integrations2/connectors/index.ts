/**
 * ETAP 8 — connector registry: `IntegrationType` → connector.
 *
 *   WEBHOOK / MAKE / ZAPIER  webhook.ts
 *   GOOGLE_SHEETS            sheets.ts
 *   TELEGRAM                 telegram-hot.ts   (HOT card subscription; the lead card is the production pipeline)
 *   AMOCRM / BITRIX24        enrich-amo.ts / enrich-bitrix.ts (opt-in enrichment; the lead push is the production pipeline)
 */

import type { Integration, IntegrationType } from "@/app/generated/prisma/client";
import { amoEnrichConnector } from "./enrich-amo";
import { bitrixEnrichConnector } from "./enrich-bitrix";
import { sheetsConnector } from "./sheets";
import { telegramHotConnector } from "./telegram-hot";
import type { ConnectionCheckResult, OutboundConnector } from "./types";
import { webhookConnector } from "./webhook";

const REGISTRY: Record<IntegrationType, OutboundConnector> = {
  WEBHOOK: webhookConnector,
  MAKE: webhookConnector,
  ZAPIER: webhookConnector,
  GOOGLE_SHEETS: sheetsConnector,
  TELEGRAM: telegramHotConnector,
  AMOCRM: amoEnrichConnector,
  BITRIX24: bitrixEnrichConnector,
};

export function getConnector(type: IntegrationType): OutboundConnector {
  return REGISTRY[type];
}

/** The types that exist only on the bus (never get a `LeadDelivery`, have no legacy connection check). */
export const BUS_ONLY_TYPES = ["WEBHOOK", "GOOGLE_SHEETS", "MAKE", "ZAPIER"] as const;

export function isBusOnlyType(type: string): boolean {
  return (BUS_ONLY_TYPES as readonly string[]).includes(type);
}

/** `checkIntegration` for the bus-only types (lib/integrations/service dispatches here). */
export async function checkBusIntegration(integration: Integration): Promise<ConnectionCheckResult> {
  return getConnector(integration.type).check(integration);
}

export type { ConnectionCheckResult, ConnectorResult, OutboundConnector, SendContext } from "./types";
