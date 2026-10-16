/**
 * ETAP 8 — outbound event payload v1 (TZ 41–42).
 *
 * One JSON shape for every event type, snake_case so Make / Zapier field
 * mapping reads naturally. Sections that do not apply to an event are
 * `null`, never missing, so a receiver can map `lead.phone` once and get
 * `null` for a `broadcast.completed`. `transcript` is the only optional
 * key: it is added when the subscription asks for it.
 *
 * `buildPayload` assembles the payload from in-memory objects (lead, score
 * insight, CRM contact, deal, handoff, broadcast). The DB layer loads the
 * rows, maps them onto these shapes and freezes the result into
 * `OutboundEvent.payload`; from then on the payload never changes, so a
 * redelivery sends exactly what the first attempt sent.
 *
 * Pure: no Prisma, no network.
 */

import { z } from "zod";
import { OUTBOUND_EVENT_TYPES, RESPONSE_SNIPPET_MAX, type OutboundEventType } from "./config";

// ─── Schema ───────────────────────────────────────────────────────────────────

export const PAYLOAD_VERSION = 1 as const;

export const TEMPERATURES = ["COLD", "WARM", "HOT", "CUSTOMER", "LOST"] as const;
export type PayloadTemperature = (typeof TEMPERATURES)[number];

export const SCORE_BANDS = ["cold", "warm", "hot", "very_hot"] as const;
export type ScoreBandKey = (typeof SCORE_BANDS)[number];

export const SOURCE_CHANNELS = [
  "instagram_dm",
  "comment",
  "story",
  "ad",
  "link",
  "broadcast",
  "import",
  "unknown",
] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

const nullableString = z.string().nullable();

export const outboundPayloadV1Schema = z.object({
  id: z.string().min(1),
  type: z.enum(OUTBOUND_EVENT_TYPES),
  version: z.literal(PAYLOAD_VERSION),
  /** ISO 8601, UTC. */
  occurred_at: z.string().min(1),
  is_test: z.boolean(),
  workspace: z.object({ id: z.string().min(1), name: z.string() }),
  account: z.object({ id: z.string().min(1), username: z.string() }).nullable(),
  lead: z
    .object({
      id: z.string().min(1),
      name: nullableString,
      /** Full E.164 (owner decision: no masking in payloads). */
      phone: nullableString,
      ig_username: nullableString,
      ig_user_id: nullableString,
      product: nullableString,
      summary: nullableString,
      extra_field: nullableString,
      is_repeat: z.boolean(),
      created_at: z.string(),
      conversation_id: nullableString,
      conversation_url: nullableString,
    })
    .nullable(),
  score: z
    .object({
      value: z.number().int().min(0).max(100),
      temperature: z.enum(TEMPERATURES),
      band: z.enum(SCORE_BANDS),
      signals: z.array(z.object({ signal: z.string(), points: z.number() })),
    })
    .nullable(),
  source: z
    .object({
      /** "campaign" | "inbound_dm" for leads, the CRM contact source otherwise. */
      kind: z.string(),
      channel: z.enum(SOURCE_CHANNELS),
      campaign: nullableString,
      keyword: nullableString,
      ad_id: nullableString,
      ref: nullableString,
    })
    .nullable(),
  contact: z
    .object({
      id: z.string().min(1),
      status: z.string(),
      tags: z.array(z.string()),
      assigned_member: z.object({ id: z.string(), name: nullableString }).nullable(),
    })
    .nullable(),
  deal: z
    .object({
      id: z.string().min(1),
      pipeline: z.string(),
      stage: z.string(),
      stage_id: nullableString,
      from_stage: nullableString,
    })
    .nullable(),
  extra: z
    .object({
      email: nullableString,
      budget: nullableString,
      location: nullableString,
    })
    .nullable(),
  handoff: z
    .object({
      id: z.string().min(1),
      reason: z.string(),
      state: z.string(),
      opened_at: z.string(),
    })
    .nullable(),
  broadcast: z
    .object({
      id: z.string().min(1),
      name: z.string(),
      sent: z.number().int().min(0),
      failed: z.number().int().min(0),
      skipped: z.number().int().min(0),
      completed_at: z.string(),
    })
    .nullable(),
  transcript: z.string().optional(),
});

export type OutboundPayloadV1 = z.infer<typeof outboundPayloadV1Schema>;

// ─── Dedupe keys ──────────────────────────────────────────────────────────────

/**
 * `OutboundEvent.dedupeKey`, unique per workspace. Conventions:
 *
 *   lead.created         lead.id
 *   lead.hot             lead.id                 (once per lead)
 *   lead.updated         lead.id + updatedAt
 *   contact.tagged       contact.id + tag slug
 *   deal.stage_changed   deal.id + stage id + changedAt
 *   handoff.opened       handoff.id
 *   broadcast.completed  broadcast.id
 */
export function dedupeKeyFor(
  type: OutboundEventType,
  subjectId: string,
  ...parts: Array<string | number | Date | null | undefined>
): string {
  const tail = parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => (p instanceof Date ? p.toISOString() : String(p)));
  return [type, subjectId, ...tail].join(":");
}

// ─── Score bands (local copy of TZ 24 defaults) ───────────────────────────────

export interface BandThresholds {
  warm: number;
  hot: number;
  veryHot: number;
}

/** Same numbers as lib/javobai/config DEFAULT_SCORING.thresholds. */
export const DEFAULT_BAND_THRESHOLDS: BandThresholds = { warm: 30, hot: 60, veryHot: 80 };

export function bandForScore(score: number, thresholds: BandThresholds = DEFAULT_BAND_THRESHOLDS): ScoreBandKey {
  if (score >= thresholds.veryHot) return "very_hot";
  if (score >= thresholds.hot) return "hot";
  if (score >= thresholds.warm) return "warm";
  return "cold";
}

/** "Very hot" / "very_hot" / "HOT" → the snake_case band key. */
export function normalizeBand(value: string): ScoreBandKey {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (SCORE_BANDS as readonly string[]).includes(key) ? (key as ScoreBandKey) : "cold";
}

// ─── Input shapes ─────────────────────────────────────────────────────────────

/** `Lead` row, as much of it as the payload needs. */
export interface LeadLike {
  id: string;
  name?: string | null;
  phoneE164?: string | null;
  igUsername?: string | null;
  igUserId?: string | null;
  productInterest?: string | null;
  summary?: string | null;
  extraField?: string | null;
  source?: "CAMPAIGN" | "INBOUND_DM" | null;
  campaignName?: string | null;
  triggerKeyword?: string | null;
  isTest?: boolean;
  isRepeat?: boolean;
  createdAt: Date | string;
  conversationId?: string | null;
  transcript?: string | null;
}

/** `AiLeadInsight` row (or the live `AiConversationState` score). */
export interface InsightLike {
  score: number;
  temperature?: PayloadTemperature | null;
  signals?: Array<{ signal: string; points: number }> | null;
  email?: string | null;
  budget?: string | null;
  location?: string | null;
}

/** `CrmContact` row with its tag slugs and assignee resolved. */
export interface ContactLike {
  id: string;
  status: string;
  source?: string | null;
  tags?: string[];
  assignedMember?: { id: string; name?: string | null } | null;
}

export interface DealLike {
  id: string;
  pipelineName: string;
  stageName: string;
  stageId?: string | null;
  fromStageName?: string | null;
}

export interface HandoffLike {
  id: string;
  reason: string;
  state: string;
  openedAt: Date | string;
}

export interface BroadcastLike {
  id: string;
  name: string;
  sent: number;
  failed: number;
  skipped: number;
  completedAt: Date | string;
}

export interface BuildPayloadInput {
  type: OutboundEventType;
  /** The `OutboundEvent.id` (any stable id for previews). */
  eventId: string;
  occurredAt?: Date | string;
  /** Defaults to `lead.isTest`; the test button passes `true`. */
  isTest?: boolean;
  workspace: { id: string; name: string };
  account?: { id: string; username: string } | null;
  lead?: LeadLike | null;
  insight?: InsightLike | null;
  contact?: ContactLike | null;
  deal?: DealLike | null;
  handoff?: HandoffLike | null;
  broadcast?: BroadcastLike | null;
  /** Attribution the rows do not carry (ad id / ref from the trigger contact). */
  source?: { channel?: SourceChannel; adId?: string | null; ref?: string | null } | null;
  /** Subscription `include_transcript` — adds `transcript` when the lead has one. */
  includeTranscript?: boolean;
  /** Public app origin for `lead.conversation_url` (no trailing slash). */
  baseUrl?: string | null;
  thresholds?: BandThresholds;
  /** Workspace-specific band function (lib/javobai/scoring bandFor); its result is normalised. */
  bandFor?: (score: number) => string;
}

// ─── Assembler ────────────────────────────────────────────────────────────────

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function orNull(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

const CONTACT_SOURCE_CHANNEL: Record<string, SourceChannel> = {
  COMMENT: "comment",
  STORY: "story",
  DM: "instagram_dm",
  AD: "ad",
  LINK: "link",
  BROADCAST: "broadcast",
  IMPORT: "import",
  UNKNOWN: "unknown",
};

function temperatureFromBand(band: ScoreBandKey): PayloadTemperature {
  if (band === "hot" || band === "very_hot") return "HOT";
  if (band === "warm") return "WARM";
  return "COLD";
}

export function buildPayload(input: BuildPayloadInput): OutboundPayloadV1 {
  const { lead, insight, contact, deal, handoff, broadcast } = input;
  const conversationId = orNull(lead?.conversationId);
  const baseUrl = input.baseUrl?.replace(/\/+$/, "") ?? null;

  const leadSection = lead
    ? {
        id: lead.id,
        name: orNull(lead.name),
        phone: orNull(lead.phoneE164),
        ig_username: orNull(lead.igUsername),
        ig_user_id: orNull(lead.igUserId),
        product: orNull(lead.productInterest),
        summary: orNull(lead.summary),
        extra_field: orNull(lead.extraField),
        is_repeat: Boolean(lead.isRepeat),
        created_at: iso(lead.createdAt),
        conversation_id: conversationId,
        conversation_url: baseUrl && conversationId ? `${baseUrl}/inbox?conversation=${conversationId}` : null,
      }
    : null;

  let scoreSection: OutboundPayloadV1["score"] = null;
  if (insight && Number.isFinite(insight.score)) {
    const value = Math.max(0, Math.min(100, Math.round(insight.score)));
    const band = input.bandFor ? normalizeBand(input.bandFor(value)) : bandForScore(value, input.thresholds);
    scoreSection = {
      value,
      temperature: insight.temperature ?? temperatureFromBand(band),
      band,
      signals: (insight.signals ?? [])
        .filter((s) => s && typeof s.signal === "string" && Number.isFinite(Number(s.points)))
        .map((s) => ({ signal: s.signal, points: Number(s.points) })),
    };
  }

  let sourceSection: OutboundPayloadV1["source"] = null;
  if (lead || contact || input.source) {
    const contactChannel = contact?.source ? CONTACT_SOURCE_CHANNEL[contact.source] : undefined;
    const kind = lead
      ? lead.source === "CAMPAIGN"
        ? "campaign"
        : "inbound_dm"
      : (contact?.source ?? "unknown").toLowerCase();
    sourceSection = {
      kind,
      channel: input.source?.channel ?? contactChannel ?? (lead ? "instagram_dm" : "unknown"),
      campaign: orNull(lead?.campaignName),
      keyword: orNull(lead?.triggerKeyword),
      ad_id: orNull(input.source?.adId),
      ref: orNull(input.source?.ref),
    };
  }

  const extra =
    insight && (insight.email || insight.budget || insight.location)
      ? { email: orNull(insight.email), budget: orNull(insight.budget), location: orNull(insight.location) }
      : null;

  const payload: OutboundPayloadV1 = {
    id: input.eventId,
    type: input.type,
    version: PAYLOAD_VERSION,
    occurred_at: iso(input.occurredAt ?? new Date()),
    is_test: input.isTest ?? Boolean(lead?.isTest),
    workspace: { id: input.workspace.id, name: input.workspace.name },
    account: input.account ? { id: input.account.id, username: input.account.username } : null,
    lead: leadSection,
    score: scoreSection,
    source: sourceSection,
    contact: contact
      ? {
          id: contact.id,
          status: contact.status,
          tags: [...new Set((contact.tags ?? []).map((t) => t.trim()).filter(Boolean))],
          assigned_member: contact.assignedMember
            ? { id: contact.assignedMember.id, name: orNull(contact.assignedMember.name) }
            : null,
        }
      : null,
    deal: deal
      ? {
          id: deal.id,
          pipeline: deal.pipelineName,
          stage: deal.stageName,
          stage_id: orNull(deal.stageId),
          from_stage: orNull(deal.fromStageName),
        }
      : null,
    extra,
    handoff: handoff
      ? { id: handoff.id, reason: handoff.reason, state: handoff.state, opened_at: iso(handoff.openedAt) }
      : null,
    broadcast: broadcast
      ? {
          id: broadcast.id,
          name: broadcast.name,
          sent: broadcast.sent,
          failed: broadcast.failed,
          skipped: broadcast.skipped,
          completed_at: iso(broadcast.completedAt),
        }
      : null,
  };

  if (input.includeTranscript && lead?.transcript) payload.transcript = lead.transcript;
  return payload;
}

// ─── Masking ──────────────────────────────────────────────────────────────────

/** +998901234567 → +99890***4567 (same rule as lib/integrations/crypto maskPhone). */
export function maskPhoneLike(phone: string): string {
  if (phone.length <= 8) return "***";
  return `${phone.slice(0, 6)}***${phone.slice(-4)}`;
}

/**
 * Response bodies / error messages stored on a delivery: phone-looking digit
 * runs are masked (TZ 12), whitespace collapsed, length capped.
 */
export function maskSnippet(text: string | null | undefined, max = RESPONSE_SNIPPET_MAX): string {
  if (!text) return "";
  const masked = text.replace(/\+?\d{9,15}/g, (m) => maskPhoneLike(m)).replace(/\s+/g, " ").trim();
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

// ─── Samples (Events / Docs tab) ──────────────────────────────────────────────

const SAMPLE_AT = new Date("2026-10-16T09:05:00.000Z");

const SAMPLE_LEAD: LeadLike = {
  id: "lead_sample01",
  name: "Dilnoza Karimova",
  phoneE164: "+998901234567",
  igUsername: "dilnoza.k",
  igUserId: "17841400000000001",
  productInterest: "IELTS kursi",
  summary: "Narxni so'radi, dekabrgacha boshlamoqchi",
  extraField: "Yunusobod",
  source: "CAMPAIGN",
  campaignName: "Kuzgi aksiya",
  triggerKeyword: "ielts",
  isTest: false,
  isRepeat: false,
  createdAt: new Date("2026-10-16T09:04:57.000Z"),
  conversationId: "conv_sample01",
  transcript: "Mijoz: IELTS kursi qancha?\nJavobAI: 1 200 000 so'm / oy.",
};

const SAMPLE_INSIGHT: InsightLike = {
  score: 72,
  temperature: "HOT",
  signals: [
    { signal: "product_selected", points: 15 },
    { signal: "price_asked", points: 10 },
    { signal: "phone_provided", points: 30 },
    { signal: "came_from_ad", points: 17 },
  ],
  email: null,
  budget: "1 mln so'mgacha",
  location: "Toshkent",
};

const SAMPLE_CONTACT: ContactLike = {
  id: "contact_sample01",
  status: "ACTIVE",
  source: "AD",
  tags: ["ielts", "hot"],
  assignedMember: { id: "member_sample01", name: "Aziza" },
};

/** A complete example payload per event type, for the developer UI and the receiver docs. */
export function sampleEvent(type: OutboundEventType, baseUrl = "https://app.socialauto.uz"): OutboundPayloadV1 {
  const base = {
    type,
    eventId: `evt_sample_${type.replace(".", "_")}`,
    occurredAt: SAMPLE_AT,
    isTest: true,
    workspace: { id: "ws_sample01", name: "Demo o'quv markazi" },
    account: { id: "ig_sample01", username: "demo.markaz" },
    baseUrl,
  } satisfies Partial<BuildPayloadInput>;

  switch (type) {
    case "lead.created":
    case "lead.hot":
    case "lead.updated":
      return buildPayload({
        ...base,
        lead: SAMPLE_LEAD,
        insight: SAMPLE_INSIGHT,
        contact: SAMPLE_CONTACT,
        source: { adId: "120210000000000001", ref: "kuz26" },
      });
    case "contact.tagged":
      return buildPayload({ ...base, contact: { ...SAMPLE_CONTACT, tags: ["ielts", "hot", "vip"] }, insight: SAMPLE_INSIGHT });
    case "deal.stage_changed":
      return buildPayload({
        ...base,
        contact: SAMPLE_CONTACT,
        deal: {
          id: "deal_sample01",
          pipelineName: "Sotuv",
          stageName: "Taklif yuborildi",
          stageId: "stage_sample02",
          fromStageName: "Yangi",
        },
      });
    case "handoff.opened":
      return buildPayload({
        ...base,
        lead: SAMPLE_LEAD,
        insight: SAMPLE_INSIGHT,
        contact: SAMPLE_CONTACT,
        handoff: { id: "handoff_sample01", reason: "purchase_ready", state: "HANDOFF_PENDING", openedAt: SAMPLE_AT },
      });
    case "broadcast.completed":
      return buildPayload({
        ...base,
        broadcast: { id: "bc_sample01", name: "Oktabr chegirmasi", sent: 148, failed: 2, skipped: 11, completedAt: SAMPLE_AT },
      });
  }
}
