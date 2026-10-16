/**
 * ETAP 5 — defaults seeded lazily per workspace, in Uzbek (owner decision:
 * every new lead enters at "Yangi lead"; the Telegram "Bog'lanildi" button
 * moves it to "Bog'lanildi"; Won / Lost write back JavobAI's temperature).
 *
 * Pure data; the DB layer creates the rows on the first CRM visit when the
 * workspace has no pipeline / tags yet.
 */

import { normalizeForMatch } from "@/lib/triggers/keywords";
import type { CrmStageKind, CrmTemperature } from "./types";

export const DEFAULT_PIPELINE_NAME = "Asosiy voronka";

export interface DefaultStage {
  /** Stable key for code that moves deals by event (lead contacted → CONTACTED). */
  key: "NEW" | "CONTACTED" | "QUALIFIED" | "HOT" | "NEGOTIATION" | "WON" | "LOST";
  name: string;
  kind: CrmStageKind;
  isEntry: boolean;
  sort: number;
  color: string;
}

/** TZ 30: New Lead → Contacted → Qualified → Hot → Negotiation → Won / Lost. */
export const DEFAULT_STAGES: DefaultStage[] = [
  { key: "NEW", name: "Yangi lead", kind: "OPEN", isEntry: true, sort: 0, color: "#3B82F6" },
  { key: "CONTACTED", name: "Bog'lanildi", kind: "OPEN", isEntry: false, sort: 1, color: "#06B6D4" },
  { key: "QUALIFIED", name: "Saralangan", kind: "OPEN", isEntry: false, sort: 2, color: "#8B5CF6" },
  { key: "HOT", name: "Hot", kind: "OPEN", isEntry: false, sort: 3, color: "#F97316" },
  { key: "NEGOTIATION", name: "Muzokara", kind: "OPEN", isEntry: false, sort: 4, color: "#EAB308" },
  { key: "WON", name: "Yutildi", kind: "WON", isEntry: false, sort: 5, color: "#22C55E" },
  { key: "LOST", name: "Yo'qotildi", kind: "LOST", isEntry: false, sort: 6, color: "#EF4444" },
];

/** Temperature JavobAI gets when a deal closes (owner decision 1). */
export const STAGE_KIND_TEMPERATURE: Partial<Record<CrmStageKind, CrmTemperature>> = {
  WON: "CUSTOMER",
  LOST: "LOST",
};

export interface DefaultTag {
  name: string;
  slug: string;
  color: string;
}

/** "tO'lov  kutilmoqda" → "tolov-kutilmoqda": unique per workspace, safe in URLs and filters. */
export function tagSlug(name: string): string {
  return normalizeForMatch(name).replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
}

/** TZ 28 examples, in Uzbek. */
export const DEFAULT_TAGS: DefaultTag[] = [
  { name: "HOT", slug: "hot", color: "#EF4444" },
  { name: "VIP", slug: "vip", color: "#F59E0B" },
  { name: "YANGI", slug: "yangi", color: "#3B82F6" },
  { name: "QAYTA", slug: "qayta", color: "#8B5CF6" },
  { name: "TO'LOV KUTILMOQDA", slug: "tolov-kutilmoqda", color: "#F97316" },
];

export interface BroadcastDefaults {
  /** Recipients per hour per broadcast (the 750/h account bucket still applies). */
  throttlePerHour: number;
  /** One broadcast per person per this many hours. */
  frequencyCapHours: number;
  /** A reply inside this many hours after the send is attributed to the broadcast. */
  replyWindowHours: number;
  /** A deal created or advanced inside this many days counts as a conversion. */
  conversionWindowDays: number;
}

export const DEFAULT_BROADCAST: BroadcastDefaults = {
  throttlePerHour: 100,
  frequencyCapHours: 24,
  replyWindowHours: 48,
  conversionWindowDays: 7,
};

/** Reconciler cadence (safety net behind the engine hooks). */
export const CRM_RECONCILE_INTERVAL_MS = 5 * 60_000;
