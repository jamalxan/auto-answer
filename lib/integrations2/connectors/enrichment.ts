/**
 * ETAP 8.4 — what the amoCRM / Bitrix24 enrichment shares: the opt-in config
 * (`Integration.config.enrich`), the stage map lookup and the wait for the
 * production lead push.
 *
 * Enrichment is strictly one-way and additive: it never creates a CRM lead.
 * It waits for the production `LeadDelivery` (kind "new") of the same lead
 * and integration to be SENT, so the CRM lead exists and its id is known,
 * then updates that lead.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { OutboundPayloadV1 } from "../events";
import type { ConnectorResult } from "./types";

export const ENRICH_EVENT_TYPES = ["lead.created", "lead.hot", "deal.stage_changed"] as const;

/** How long a waiting enrichment is re-checked, and when it gives up. */
export const ENRICH_WAIT_MS = 60_000;
export const ENRICH_GIVE_UP_MS = 6 * 60 * 60_000;

export const enrichConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** amoCRM: numeric custom-field id; Bitrix24: the UF_CRM_… code. Empty = no score field. */
  scoreFieldId: z.union([z.number().int().positive(), z.string().trim().min(1).max(100)]).optional(),
  /** amoCRM: add `hot` / `warm` tags. Bitrix24 has no tags: the temperature goes into the comment. */
  temperatureTag: z.boolean().default(true),
  /** CrmStage name (or id) → amoCRM status id / Bitrix24 STATUS_ID. */
  stageMap: z.record(z.string().trim().min(1).max(120), z.union([z.number().int().positive(), z.string().trim().min(1).max(60)])).default({}),
});

export type EnrichConfig = z.infer<typeof enrichConfigSchema>;

export function readEnrichConfig(config: unknown): EnrichConfig | null {
  const raw = config && typeof config === "object" ? (config as { enrich?: unknown }).enrich : null;
  if (!raw) return null;
  const parsed = enrichConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The mapped CRM status for the deal's new stage (name, case-insensitive, or stage id). */
export function mappedStatus(stageMap: EnrichConfig["stageMap"], deal: NonNullable<OutboundPayloadV1["deal"]>): string | number | null {
  const wanted = [deal.stage, deal.stage_id].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase());
  for (const [key, value] of Object.entries(stageMap)) {
    if (wanted.includes(key.toLowerCase())) return value;
  }
  return null;
}

export type LeadPush = { ok: true; externalId: string } | { ok: false; result: ConnectorResult };

/**
 * The CRM lead id the production pipeline created for this payload's lead
 * on this integration, or the connector result that explains why not yet.
 */
export async function awaitLeadPush(args: {
  leadId: string | null | undefined;
  integrationId: string;
  deliveryCreatedAt: Date;
  crmLabel: string;
  now?: Date;
}): Promise<LeadPush> {
  const now = args.now ?? new Date();
  if (!args.leadId) {
    return { ok: false, result: { outcome: "skipped", note: "Bu hodisada lead yo'q — CRM'ni boyitish kerak emas" } };
  }
  const push = await prisma.leadDelivery.findFirst({
    where: { leadId: args.leadId, integrationId: args.integrationId, kind: "new" },
    select: { status: true, externalId: true },
  });
  if (!push) {
    return { ok: false, result: { outcome: "skipped", note: `Lead ${args.crmLabel}'ga yuborilmagan (ulanish keyin qo'shilgan) — boyitish o'tkazib yuborildi` } };
  }
  if (push.status === "SENT" && push.externalId) return { ok: true, externalId: push.externalId };
  if (push.status === "DEAD") {
    return { ok: false, result: { outcome: "dead", note: `Lead ${args.crmLabel}'ga yetkazilmadi — boyitish mumkin emas` } };
  }
  if (now.getTime() - args.deliveryCreatedAt.getTime() > ENRICH_GIVE_UP_MS) {
    return { ok: false, result: { outcome: "dead", note: `Lead ${args.crmLabel}'ga 6 soat ichida yetkazilmadi — boyitish bekor qilindi` } };
  }
  return {
    ok: false,
    result: { outcome: "wait", note: `Lead hali ${args.crmLabel}'ga yetkazilmagan — kutilmoqda`, delayMs: ENRICH_WAIT_MS },
  };
}

/** Plain-text score note (amoCRM notes and Bitrix timeline comments do not render HTML). */
export function scoreNoteText(payload: OutboundPayloadV1): string {
  const lines: string[] = [];
  const score = payload.score;
  if (score) {
    lines.push(`SocialAuto ball: ${score.value} (${score.temperature})`);
    if (score.signals.length) lines.push(`Signallar: ${score.signals.map((s) => `${s.signal} +${s.points}`).join(", ")}`);
  }
  if (payload.extra?.budget) lines.push(`Byudjet: ${payload.extra.budget}`);
  if (payload.extra?.location) lines.push(`Joylashuv: ${payload.extra.location}`);
  if (payload.deal) lines.push(`Bosqich: ${payload.deal.from_stage ? `${payload.deal.from_stage} → ` : ""}${payload.deal.stage}`);
  return lines.join("\n");
}

export function temperatureTagOf(payload: OutboundPayloadV1): "hot" | "warm" | null {
  const band = payload.score?.band;
  if (band === "hot" || band === "very_hot") return "hot";
  if (band === "warm") return "warm";
  return null;
}
