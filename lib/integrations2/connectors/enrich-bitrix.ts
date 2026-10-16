/**
 * ETAP 8.4 — Bitrix24 enrichment (opt-in, `config.enrich.enabled`).
 *
 *   lead.created / lead.hot   score into the UF field + timeline comment (temperature included)
 *   deal.stage_changed        STATUS_ID from `enrich.stageMap`
 *
 * Bitrix24 leads have no tags, so `temperatureTag` only shapes the comment.
 * Waits for the production lead push first (enrichment.ts). The idempotent
 * update goes first, the comment last, so a retry never duplicates it.
 */

import type { Integration } from "@/app/generated/prisma/client";
import { BitrixClient, bitrixLeadUrl, type BitrixConfig } from "@/lib/integrations/bitrix24";
import { decryptCredentials } from "@/lib/integrations/crypto";
import { ENRICH_EVENT_TYPES, awaitLeadPush, mappedStatus, readEnrichConfig, scoreNoteText } from "./enrichment";
import type { ConnectionCheckResult, ConnectorResult, OutboundConnector, SendContext } from "./types";

function clientFor(integration: Integration): BitrixClient {
  const credentials = decryptCredentials<{ webhookUrl: string }>(integration.credentialsEncrypted);
  return new BitrixClient(credentials.webhookUrl, integration.config as unknown as BitrixConfig, integration.id);
}

export const bitrixEnrichConnector: OutboundConnector = {
  supports: (type) => (ENRICH_EVENT_TYPES as readonly string[]).includes(type),

  async send(context: SendContext): Promise<ConnectorResult> {
    const enrich = readEnrichConfig(context.integration.config);
    if (!enrich?.enabled) return { outcome: "skipped", note: "Bitrix24 boyitish o'chirilgan" };
    const { payload } = context;

    const push = await awaitLeadPush({
      leadId: payload.lead?.id,
      integrationId: context.integration.id,
      deliveryCreatedAt: context.delivery.createdAt,
      crmLabel: "Bitrix24",
    });
    if (!push.ok) return push.result;

    const client = clientFor(context.integration);
    const crmLeadId = Number(push.externalId);
    if (!Number.isFinite(crmLeadId)) return { outcome: "dead", note: "Bitrix24 lead id noto'g'ri" };
    const result = { externalId: push.externalId, externalUrl: bitrixLeadUrl(client.webhookUrl, crmLeadId) };

    if (context.event.type === "deal.stage_changed") {
      const status = payload.deal ? mappedStatus(enrich.stageMap, payload.deal) : null;
      if (status === null) return { outcome: "skipped", note: `«${payload.deal?.stage ?? "?"}» bosqichi Bitrix24 statusiga bog'lanmagan`, ...result };
      await client.call("crm.lead.update", { id: crmLeadId, fields: { STATUS_ID: String(status) } });
      return { outcome: "sent", responseSnippet: `STATUS_ID ${status}`, ...result };
    }

    const fields: Record<string, unknown> = {};
    if (typeof enrich.scoreFieldId === "string" && payload.score) fields[enrich.scoreFieldId] = payload.score.value;
    if (Object.keys(fields).length > 0) await client.call("crm.lead.update", { id: crmLeadId, fields });
    const note = scoreNoteText(payload);
    if (note) await client.addComment(crmLeadId, `${payload.is_test ? "[TEST] " : ""}${context.event.type === "lead.hot" ? "🔥 HOT\n" : ""}${note}`);
    return { outcome: "sent", responseSnippet: Object.keys(fields).join(", "), ...result };
  },

  async check(integration: Integration): Promise<ConnectionCheckResult> {
    return readEnrichConfig(integration.config)?.enabled
      ? { ok: true }
      : { ok: false, reason: "error", message: "Boyitish yoqilmagan" };
  },
};
