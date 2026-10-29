/**
 * Types and small helpers of the Analytics (ETAP 10) screen.
 * Client-safe: type-only imports from the server modules, no server code.
 */

import type { AnalyticsResult } from "@/lib/analytics/read";
import type { KpiData } from "@/lib/analytics/kpi";

export { requestJson, jsonInit, type JsonResult } from "@/components/developer/comments/shared";
export type { AnalyticsResult, KpiData };

export const ANALYTICS_API = "/api/analytics";

export const TABS = [
  ["campaign", "Kampaniya"],
  ["ai", "AI"],
  ["sales", "Sotuv"],
  ["funnel", "Funnel"],
  ["kpi", "KPI"],
] as const;
export type DashboardTab = (typeof TABS)[number][0];

export const PRESETS = [
  ["today", "Bugun"],
  ["7d", "7 kun"],
  ["30d", "30 kun"],
  ["custom", "Maxsus"],
] as const;
export type Preset = (typeof PRESETS)[number][0];

export interface AlertRuleView {
  id: string;
  label: string;
  threshold: string;
  lastAlertedAt: string | null;
}

export type KpiResponse = KpiData & { alertRules: AlertRuleView[]; queueDepthsRestricted?: boolean };

/** Which tile metrics are drawn as lines by default, per tab. */
export const DEFAULT_CHART_KEYS: Record<string, string[]> = {
  campaign: ["campaign.sent", "campaign.replies", "campaign.clicks", "campaign.leads"],
  ai: ["ai.conversations", "ai.handoff", "ai.qualified"],
  sales: ["sales.leads", "sales.won", "sales.lost"],
};

/** "2026-10-15" -> "15.10". */
export function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${date}.${month}`;
}

export function formatDelta(deltaPct: number | null): string {
  if (deltaPct === null) return "";
  return `${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1).replace(/\.0$/, "")}%`;
}

export function formatAgeMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} daq`;
}
