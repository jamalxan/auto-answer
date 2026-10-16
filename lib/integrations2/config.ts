/**
 * ETAP 8 — Integrations 2.0: constants and the kill switch.
 *
 * Pure: no Prisma, no Redis. The `OutboundEvent` / `OutboundDelivery` /
 * `IntegrationSubscription` tables and the new `IntegrationType` values are
 * added later; until then everything in lib/integrations2 works on the
 * explicit shapes declared in events.ts.
 */

// ─── Kill switch ──────────────────────────────────────────────────────────────

/** `INTEGRATIONS_BUS_DISABLED=1` stops emit / materialise / deliver without touching the lead pipeline. */
export function isOutboundBusEnabled(): boolean {
  return process.env.INTEGRATIONS_BUS_DISABLED !== "1";
}

// ─── Events ───────────────────────────────────────────────────────────────────

export const OUTBOUND_EVENT_TYPES = [
  "lead.created",
  "lead.hot",
  "lead.updated",
  "contact.tagged",
  "deal.stage_changed",
  "handoff.opened",
  "broadcast.completed",
] as const;

export type OutboundEventType = (typeof OUTBOUND_EVENT_TYPES)[number];

export const OUTBOUND_EVENT_INFO: Record<OutboundEventType, { label: string; description: string }> = {
  "lead.created": {
    label: "Yangi lead",
    description: "Mijoz telefon raqamini qoldirdi va lead yaratildi (3 soniyadan keyin, score bilan birga).",
  },
  "lead.hot": {
    label: "HOT lead",
    description: "Lead bali HOT chegarasiga yetdi (TZ 24). Har bir lead uchun bir marta.",
  },
  "lead.updated": {
    label: "Lead yangilandi",
    description: "Lead maydonlari (ism, mahsulot, xulosa, qo'shimcha ma'lumot) o'zgardi.",
  },
  "contact.tagged": {
    label: "Kontaktga teg qo'shildi",
    description: "CRM kontaktiga yangi teg qo'shildi (qo'lda, JavobAI yoki avtomatlashtirish).",
  },
  "deal.stage_changed": {
    label: "Bitim bosqichi o'zgardi",
    description: "CRM bitimi pipeline'da boshqa bosqichga o'tdi.",
  },
  "handoff.opened": {
    label: "Operatorga o'tish",
    description: "JavobAI suhbatni operatorga uzatdi (sabab bilan).",
  },
  "broadcast.completed": {
    label: "Broadcast yakunlandi",
    description: "Broadcast yuborilib bo'ldi — yuborilgan / o'tkazilgan / xato soni bilan.",
  },
};

export function isOutboundEventType(value: unknown): value is OutboundEventType {
  return typeof value === "string" && (OUTBOUND_EVENT_TYPES as readonly string[]).includes(value);
}

// ─── Integration types ────────────────────────────────────────────────────────

/** New `IntegrationType` values of the bus (own migration, later). */
export const INTEGRATION2_TYPES = ["WEBHOOK", "GOOGLE_SHEETS", "MAKE", "ZAPIER"] as const;

export type Integration2Type = (typeof INTEGRATION2_TYPES)[number];

export const INTEGRATION2_TYPE_LABELS: Record<Integration2Type, string> = {
  WEBHOOK: "Webhook",
  GOOGLE_SHEETS: "Google Sheets",
  MAKE: "Make",
  ZAPIER: "Zapier",
};

/**
 * The types that keep getting a `LeadDelivery` row. `enqueueLeadDeliveries`
 * must use this positive list so a bus-only integration never enters the
 * lead pipeline.
 */
export const LEAD_PIPELINE_TYPES = ["TELEGRAM", "AMOCRM", "BITRIX24"] as const;

export type LeadPipelineType = (typeof LEAD_PIPELINE_TYPES)[number];

export function isLeadPipelineType(type: string): type is LeadPipelineType {
  return (LEAD_PIPELINE_TYPES as readonly string[]).includes(type);
}

// ─── Limits ───────────────────────────────────────────────────────────────────

/** Events and deliveries older than this are purged. */
export const RETENTION_DAYS = 30;
/** Per-integration delivery rate (token bucket, one-minute window). */
export const DEFAULT_RATE_PER_MINUTE = 60;
/** This many consecutive DEAD deliveries disable the subscription. */
export const DEAD_AUTO_DISABLE = 5;
/** Lead events wait this long so the score insight (written after the lead) is included. */
export const MATERIALIZE_DELAY_MS = 3000;
/** `OutboundDelivery.responseSnippet` length (phones masked). */
export const RESPONSE_SNIPPET_MAX = 300;
/** Webhook connect + response timeout. */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** `Retry-After` beyond this is clamped (the retry schedule ends at 6h anyway). */
export const RETRY_AFTER_MAX_MS = 6 * 60 * 60 * 1000;
/** Signature timestamp skew a receiver should accept. */
export const SIGNATURE_TOLERANCE_SEC = 300;
/** After a secret rotation both secrets sign for this long. */
export const SECRET_OVERLAP_HOURS = 24;
/** Google OAuth access tokens live 60 min; the cache keeps them a little less. */
export const SHEETS_TOKEN_CACHE_SEC = 50 * 60;
