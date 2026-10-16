/**
 * ETAP 8 — `IntegrationSubscription.filter` (one JSON per integration ×
 * event type). The worker runs `matchesSubscription` against the frozen
 * payload when it materialises an event; only matching subscriptions get an
 * `OutboundDelivery`.
 *
 *   { v: 1, temperatures?, min_score?, accounts?, include_test?, channels?,
 *     tags?, stages?, include_transcript? }
 *
 * Every condition present must hold. A condition that needs a payload section
 * the event does not carry (e.g. `min_score` on `broadcast.completed`) fails,
 * so a "HOT only" subscription never receives score-less events.
 *
 * Pure: no Prisma.
 */

import { z } from "zod";
import { SOURCE_CHANNELS, TEMPERATURES, type OutboundPayloadV1 } from "./events";

// ─── Schema ───────────────────────────────────────────────────────────────────

const stringList = z.array(z.string().trim().min(1)).max(100);

export const subscriptionFilterSchema = z.strictObject({
  v: z.literal(1),
  temperatures: z.array(z.enum(TEMPERATURES)).max(TEMPERATURES.length).optional(),
  min_score: z.number().int().min(0).max(100).optional(),
  /** InstagramAccount ids; empty / absent = every account. */
  accounts: stringList.optional(),
  include_test: z.boolean().optional(),
  channels: z.array(z.enum(SOURCE_CHANNELS)).optional(),
  /** Tag slugs — any one of them. */
  tags: stringList.optional(),
  /** Stage ids or names — any one of them. */
  stages: stringList.optional(),
  include_transcript: z.boolean().optional(),
});

export type SubscriptionFilter = z.infer<typeof subscriptionFilterSchema>;

export const DEFAULT_SUBSCRIPTION_FILTER: SubscriptionFilter = { v: 1 };

/** Stored JSON → filter; anything invalid falls back to "everything, no test events". */
export function readSubscriptionFilter(value: unknown): SubscriptionFilter {
  const parsed = subscriptionFilterSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SUBSCRIPTION_FILTER;
}

// ─── Matching ─────────────────────────────────────────────────────────────────

const has = (list: string[] | undefined): list is string[] => Array.isArray(list) && list.length > 0;

export function matchesSubscription(filter: SubscriptionFilter, payload: OutboundPayloadV1): boolean {
  if (payload.is_test && !filter.include_test) return false;

  if (has(filter.temperatures)) {
    if (!payload.score || !filter.temperatures.includes(payload.score.temperature)) return false;
  }
  if (filter.min_score !== undefined) {
    if (!payload.score || payload.score.value < filter.min_score) return false;
  }
  if (has(filter.accounts)) {
    if (!payload.account || !filter.accounts.includes(payload.account.id)) return false;
  }
  if (has(filter.channels)) {
    if (!payload.source || !filter.channels.includes(payload.source.channel)) return false;
  }
  if (has(filter.tags)) {
    const tags = new Set((payload.contact?.tags ?? []).map((t) => t.toLowerCase()));
    if (!filter.tags.some((t) => tags.has(t.toLowerCase()))) return false;
  }
  if (has(filter.stages)) {
    const deal = payload.deal;
    if (!deal) return false;
    const wanted = filter.stages.map((s) => s.toLowerCase());
    const matches = wanted.includes(deal.stage.toLowerCase()) || (deal.stage_id ? wanted.includes(deal.stage_id.toLowerCase()) : false);
    if (!matches) return false;
  }
  return true;
}

// ─── Description (subscription card) ──────────────────────────────────────────

const TEMPERATURE_LABELS: Record<(typeof TEMPERATURES)[number], string> = {
  COLD: "Sovuq",
  WARM: "Iliq",
  HOT: "Hot",
  CUSTOMER: "Mijoz",
  LOST: "Yo'qotilgan",
};

const CHANNEL_LABELS: Record<(typeof SOURCE_CHANNELS)[number], string> = {
  instagram_dm: "Direct",
  comment: "Izoh",
  story: "Story",
  ad: "Reklama",
  link: "Havola",
  broadcast: "Broadcast",
  import: "Import",
  unknown: "Noma'lum",
};

export interface FilterNames {
  /** InstagramAccount id → @username. */
  accounts?: Record<string, string>;
  /** Stage id → name. */
  stages?: Record<string, string>;
}

/** One Uzbek sentence: "Hot · ball ≥ 60 · @demo · teglar: ielts · test hodisalar bilan". */
export function describeFilter(filter: SubscriptionFilter, names: FilterNames = {}): string {
  const parts: string[] = [];
  if (has(filter.temperatures)) parts.push(filter.temperatures.map((t) => TEMPERATURE_LABELS[t]).join(" / "));
  if (filter.min_score !== undefined) parts.push(`ball ≥ ${filter.min_score}`);
  if (has(filter.accounts)) {
    parts.push(filter.accounts.map((id) => `@${names.accounts?.[id] ?? id}`).join(", "));
  }
  if (has(filter.channels)) parts.push(`kanal: ${filter.channels.map((c) => CHANNEL_LABELS[c]).join(", ")}`);
  if (has(filter.tags)) parts.push(`teglar: ${filter.tags.join(", ")}`);
  if (has(filter.stages)) parts.push(`bosqich: ${filter.stages.map((s) => names.stages?.[s] ?? s).join(", ")}`);
  if (filter.include_test) parts.push("test hodisalar bilan");
  if (filter.include_transcript) parts.push("suhbat matni bilan");
  return parts.length ? parts.join(" · ") : "Barcha hodisalar (testdan tashqari)";
}
