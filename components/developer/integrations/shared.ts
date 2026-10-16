/**
 * Types, labels and small helpers of the Integrations 2.0 (ETAP 8) screens.
 * Client-safe: no server imports. The fetch helper is shared with Comment 2.0.
 */

import type { DisplayTone } from "@/lib/triggers/display";

export { jsonInit, requestJson, type JsonResult } from "@/components/developer/comments/shared";

export const INTEGRATIONS_API = "/api/developer/integrations";

export type EventType =
  | "lead.created"
  | "lead.hot"
  | "lead.updated"
  | "contact.tagged"
  | "deal.stage_changed"
  | "handoff.opened"
  | "broadcast.completed";

export type Temperature = "COLD" | "WARM" | "HOT" | "CUSTOMER" | "LOST";

export interface SubscriptionFilter {
  v: 1;
  temperatures?: Temperature[];
  min_score?: number;
  accounts?: string[];
  include_test?: boolean;
  channels?: string[];
  tags?: string[];
  stages?: string[];
  include_transcript?: boolean;
}

export interface SubscriptionView {
  id: string;
  eventType: EventType;
  filter: SubscriptionFilter;
  description: string;
  active: boolean;
}

export interface EnrichmentView {
  enabled: boolean;
  scoreFieldId: string | number | null;
  temperatureTag: boolean;
  stageMap: Record<string, string | number>;
}

export interface IntegrationView {
  id: string;
  type: "TELEGRAM" | "AMOCRM" | "BITRIX24" | "WEBHOOK" | "GOOGLE_SHEETS" | "MAKE" | "ZAPIER";
  typeLabel: string;
  legacy: boolean;
  name: string;
  status: "ACTIVE" | "BROKEN" | "DISABLED";
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  secretHint: string;
  config: Record<string, unknown>;
  igAccountFilter: string[];
  subscriptions: SubscriptionView[];
  counts: { pending: number; dead: number; sent24h: number; leadPending: number; leadDead: number };
  previousSecretExpiresAt: string | null;
  enrichment: EnrichmentView | null;
}

export interface DeliveryView {
  id: string;
  status: "PENDING" | "SENT" | "FAILED" | "DEAD" | "SKIPPED";
  attempts: number;
  maxAttempts: number;
  eventId: string;
  eventType: string;
  isTest: boolean;
  occurredAt: string | null;
  integration: { id: string; name: string; type: string } | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  responseCode: number | null;
  responseSnippet: string | null;
  signature: string | null;
  externalId: string | null;
  externalUrl: string | null;
  durationMs: number | null;
  sentAt: string | null;
  createdAt: string;
}

export interface Account {
  id: string;
  username: string;
}

export interface Meta {
  busEnabled: boolean;
  baseUrl: string;
  events: Array<{ type: EventType; label: string; description: string }>;
  connectorTypes: Array<{ type: string; label: string; events: EventType[] }>;
  enrichment: { events: EventType[]; hotEvents: EventType[]; amo: string[]; bitrix: string[] };
  limits: {
    retryDelaysSec: number[];
    maxAttempts: number;
    deadAutoDisable: number;
    retentionDays: number;
    secretOverlapHours: number;
    defaultRatePerMinute: number;
  };
  sheetHeaders: string[];
  accounts: Account[];
  stages: Array<{ id: string; name: string; pipeline: string }>;
  me: { role: string; canWrite: boolean; canViewPayload: boolean };
}

export interface ListResponse {
  integrations: IntegrationView[];
  accounts: Account[];
  busEnabled: boolean;
}

export const STATUS_TONE: Record<IntegrationView["status"], DisplayTone> = {
  ACTIVE: "success",
  BROKEN: "error",
  DISABLED: "muted",
};

export const STATUS_LABEL: Record<IntegrationView["status"], string> = {
  ACTIVE: "Faol",
  BROKEN: "To'xtagan",
  DISABLED: "O'chirilgan",
};

export const DELIVERY_TONE: Record<DeliveryView["status"], DisplayTone> = {
  PENDING: "warning",
  FAILED: "warning",
  SENT: "success",
  DEAD: "error",
  SKIPPED: "muted",
};

export const DELIVERY_LABEL: Record<DeliveryView["status"], string> = {
  PENDING: "Kutilmoqda",
  FAILED: "Qayta uriniladi",
  SENT: "Yuborildi",
  DEAD: "Yetkazilmadi",
  SKIPPED: "O'tkazildi",
};

export const TEMPERATURE_LABEL: Record<Temperature, string> = {
  COLD: "Sovuq",
  WARM: "Iliq",
  HOT: "Hot",
  CUSTOMER: "Mijoz",
  LOST: "Yo'qotilgan",
};

export const CHANNELS: Array<[string, string]> = [
  ["instagram_dm", "Direct"],
  ["comment", "Izoh"],
  ["story", "Story"],
  ["ad", "Reklama"],
  ["link", "Havola"],
  ["broadcast", "Broadcast"],
  ["import", "Import"],
];

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Copies text; false when the browser refuses (insecure context, permissions). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
