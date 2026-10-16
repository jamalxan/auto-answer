/**
 * ETAP 8 — Webhook / Make / Zapier connector (one implementation, three
 * `IntegrationType` values).
 *
 * credentials  { secret, previousSecret?, previousSecretExpiresAt? }   (encrypted)
 * config       { url, preset, rateLimitPerMinute }
 *
 * The URL policy runs again right before every send (DNS may have changed
 * since the URL was saved): a policy failure is a DEAD delivery with the
 * reason, except "host not resolvable" which is retried.
 */

import type { Integration } from "@/app/generated/prisma/client";
import { z } from "zod";
import { DEFAULT_RATE_PER_MINUTE } from "../config";
import { HEADER_SIGNATURE } from "../signing";
import { activePreviousSecret, readWebhookCredentials } from "../secrets";
import { assertOutboundUrl, type UrlPolicyOptions } from "../url-policy";
import { buildWebhookRequest, sendWebhook, type FetchImpl } from "./webhook-request";
import type { ConnectionCheckResult, ConnectorResult, OutboundConnector, SendContext } from "./types";
import { OUTBOUND_EVENT_TYPES } from "../config";

export const webhookConfigSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  preset: z.enum(["WEBHOOK", "MAKE", "ZAPIER"]).default("WEBHOOK"),
  rateLimitPerMinute: z.number().int().min(1).max(600).default(DEFAULT_RATE_PER_MINUTE),
});

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

export function readWebhookConfig(value: unknown): WebhookConfig | null {
  const parsed = webhookConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Test seam: the tests inject a resolver so no DNS lookup happens. */
let policyOptions: UrlPolicyOptions = {};
export function setWebhookPolicyOptionsForTests(options: UrlPolicyOptions): void {
  policyOptions = options;
}

export const webhookConnector: OutboundConnector = {
  supports: (type) => (OUTBOUND_EVENT_TYPES as readonly string[]).includes(type),

  async send(context: SendContext): Promise<ConnectorResult> {
    const config = readWebhookConfig(context.integration.config);
    const credentials = readWebhookCredentials(context.integration);
    if (!config || !credentials) {
      return { outcome: "dead", note: "Webhook sozlamalari yoki maxfiy kalit o'qilmadi — integratsiyani qayta yarating" };
    }

    const policy = await assertOutboundUrl(config.url, policyOptions);
    if (!policy.ok) {
      const note = `URL siyosati: ${policy.reason}`;
      return policy.code === "unresolvable" ? { outcome: "retry", note } : { outcome: "dead", note };
    }

    const request = buildWebhookRequest({
      url: policy.url,
      secret: credentials.secret,
      previousSecret: activePreviousSecret(credentials),
      event: { id: context.event.id, type: context.event.type },
      delivery: { id: context.delivery.id },
      payload: context.payload,
    });
    const signature = request.headers[HEADER_SIGNATURE] ?? null;
    const result = await sendWebhook(request, globalThis.fetch as FetchImpl);
    const common = {
      responseCode: result.status,
      responseSnippet: result.snippet,
      signature,
      durationMs: result.durationMs,
    };
    const { classification } = result;
    switch (classification.outcome) {
      case "sent":
        return { outcome: "sent", ...common };
      case "retry":
        return { outcome: "retry", note: classification.note, retryAfterMs: classification.retryAfterMs, ...common };
      case "dead_disable":
        return { outcome: "dead", note: classification.note, disableSubscription: true, ...common };
      default:
        return { outcome: "dead", note: classification.note, ...common };
    }
  },

  async check(integration: Integration): Promise<ConnectionCheckResult> {
    const config = readWebhookConfig(integration.config);
    if (!config) return { ok: false, reason: "error", message: "Webhook URL sozlanmagan" };
    if (!readWebhookCredentials(integration)) return { ok: false, reason: "auth", message: "Maxfiy kalit o'qilmadi" };
    const policy = await assertOutboundUrl(config.url, policyOptions);
    return policy.ok ? { ok: true } : { ok: false, reason: "error", message: policy.reason };
  },
};
