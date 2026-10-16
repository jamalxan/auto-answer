/**
 * ETAP 8.4 — amoCRM enrichment (opt-in, `config.enrich.enabled`).
 *
 *   lead.created / lead.hot   score custom field + `hot` / `warm` tag + score note
 *   deal.stage_changed        status from `enrich.stageMap`
 *
 * Runs after the production pipeline created the amoCRM lead (see
 * enrichment.ts). Tags are merged with the lead's existing ones because an
 * amoCRM PATCH replaces the whole tag set. The idempotent PATCH goes first,
 * the note last, so a retry never duplicates the note.
 */

import type { Integration } from "@/app/generated/prisma/client";
import { AmoClient, LongLivedTokenStrategy, amoLeadUrl, type AmoConfig } from "@/lib/integrations/amocrm";
import { decryptCredentials } from "@/lib/integrations/crypto";
import {
  ENRICH_EVENT_TYPES,
  awaitLeadPush,
  mappedStatus,
  readEnrichConfig,
  scoreNoteText,
  temperatureTagOf,
} from "./enrichment";
import type { ConnectionCheckResult, ConnectorResult, OutboundConnector, SendContext } from "./types";

function clientFor(integration: Integration): AmoClient {
  const credentials = decryptCredentials<{ token: string }>(integration.credentialsEncrypted);
  return new AmoClient(integration.config as unknown as AmoConfig, new LongLivedTokenStrategy(credentials.token), integration.id);
}

export const amoEnrichConnector: OutboundConnector = {
  supports: (type) => (ENRICH_EVENT_TYPES as readonly string[]).includes(type),

  async send(context: SendContext): Promise<ConnectorResult> {
    const enrich = readEnrichConfig(context.integration.config);
    if (!enrich?.enabled) return { outcome: "skipped", note: "amoCRM boyitish o'chirilgan" };
    const { payload } = context;

    const push = await awaitLeadPush({
      leadId: payload.lead?.id,
      integrationId: context.integration.id,
      deliveryCreatedAt: context.delivery.createdAt,
      crmLabel: "amoCRM",
    });
    if (!push.ok) return push.result;

    const client = clientFor(context.integration);
    const amoConfig = context.integration.config as unknown as AmoConfig;
    const crmLeadId = Number(push.externalId);
    if (!Number.isFinite(crmLeadId)) return { outcome: "dead", note: "amoCRM lead id noto'g'ri" };
    const result = { externalId: push.externalId, externalUrl: amoLeadUrl(amoConfig, crmLeadId) };

    if (context.event.type === "deal.stage_changed") {
      const status = payload.deal ? mappedStatus(enrich.stageMap, payload.deal) : null;
      if (status === null) return { outcome: "skipped", note: `«${payload.deal?.stage ?? "?"}» bosqichi amoCRM statusiga bog'lanmagan`, ...result };
      await client.updateLead(crmLeadId, { status_id: Number(status) });
      return { outcome: "sent", responseSnippet: `status ${status}`, ...result };
    }

    const patch: Record<string, unknown> = {};
    const tag = enrich.temperatureTag ? temperatureTagOf(payload) : null;
    if (tag) {
      const current = await client.getLead(crmLeadId);
      const names = (current?._embedded?.tags ?? []).map((t) => t.name);
      if (!names.some((n) => n.toLowerCase() === tag)) {
        patch._embedded = { tags: [...names, tag].map((name) => ({ name })) };
      }
    }
    if (typeof enrich.scoreFieldId === "number" && payload.score) {
      patch.custom_fields_values = [{ field_id: enrich.scoreFieldId, values: [{ value: payload.score.value }] }];
    }
    if (Object.keys(patch).length > 0) await client.updateLead(crmLeadId, patch);
    const note = scoreNoteText(payload);
    if (note) await client.addNote(crmLeadId, `${payload.is_test ? "[TEST] " : ""}${context.event.type === "lead.hot" ? "🔥 HOT\n" : ""}${note}`);
    return { outcome: "sent", responseSnippet: Object.keys(patch).join(", "), ...result };
  },

  async check(integration: Integration): Promise<ConnectionCheckResult> {
    return readEnrichConfig(integration.config)?.enabled
      ? { ok: true }
      : { ok: false, reason: "error", message: "Boyitish yoqilmagan" };
  },
};
