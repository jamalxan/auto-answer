/**
 * ETAP 10 - the read side. Everything here comes from AnalyticsDaily rollups
 * (compute.ts is the only place a metric is defined); the only live reads are
 * labels (campaign names) and the account list.
 *
 * A range is a set of Tashkent days. `partial` is true when it includes today:
 * that day is refreshed every ~10 minutes and is still filling up.
 */

import { prisma } from "@/lib/db/client";
import { JAVOBAI_USAGE_KIND_LABELS } from "@/lib/javobai/usage";
import {
  ANALYTICS_TABS,
  COHORT_METRICS,
  DIM_KINDS,
  LLM_ERROR_LABELS,
  PRODUCTION_USAGE_KIND_LABELS,
  FUNNEL_NOTE,
  FUNNEL_STAGES,
  defaultDimKinds,
  deriveValue,
  derivedForTab,
  isDimKind,
  metricsForTab,
  storedKeysForTab,
  type AnalyticsTab,
  type DerivedDef,
  type DimKind,
  type MetricFormat,
} from "./catalog";
import { computeCohortFunnel, type FunnelStage } from "./funnel-cohort";
import { columnToKey, dayColumn, isDayKey, listDayKeys, previousRange, resolveRange, type ResolvedRange } from "./time";

export type CompareMode = "none" | "previous" | "custom" | "dim" | "ai_human";
const COMPARE_MODES: CompareMode[] = ["none", "previous", "custom", "dim", "ai_human"];

export interface ReadParams {
  tab: AnalyticsTab;
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  accountId?: string | null;
  /** Restrict the breakdown to one dimension kind. */
  dim?: DimKind | null;
  compare: CompareMode;
  compareFrom?: string | null;
  compareTo?: string | null;
  /** compare=dim: the two slices of `dim` to put side by side. */
  dimA?: string | null;
  dimB?: string | null;
  mode: "period" | "cohort";
}

export type ParseResult = { ok: true; params: ReadParams } | { ok: false; error: string };

export function parseReadQuery(search: URLSearchParams): ParseResult {
  const tab = (search.get("tab") ?? "campaign") as AnalyticsTab;
  if (!ANALYTICS_TABS.includes(tab)) return { ok: false, error: "Noma'lum bo'lim (tab)" };
  const compare = (search.get("compare") ?? "previous") as CompareMode;
  if (!COMPARE_MODES.includes(compare)) return { ok: false, error: "Noma'lum taqqoslash turi" };
  const dim = search.get("dim");
  if (dim && !isDimKind(dim)) return { ok: false, error: `dim quyidagilardan biri bo'lishi kerak: ${DIM_KINDS.join(", ")}` };
  const mode = search.get("mode") === "cohort" ? "cohort" : "period";
  return {
    ok: true,
    params: {
      tab,
      preset: search.get("preset"),
      from: search.get("from"),
      to: search.get("to"),
      accountId: search.get("accountId") || null,
      dim: (dim as DimKind | null) || null,
      compare,
      compareFrom: search.get("compareFrom"),
      compareTo: search.get("compareTo"),
      dimA: search.get("dimA"),
      dimB: search.get("dimB"),
      mode,
    },
  };
}

// ─── Result shape ────────────────────────────────────────────────────────────

export interface MetricValue {
  value: number | null;
  compare: number | null;
  /** (value - compare) / compare in percent; null when compare is 0 or missing. */
  deltaPct: number | null;
  derived?: boolean;
  format: MetricFormat;
  label: string;
}

export type SeriesPoint = { day: string } & Record<string, number | string | null>;

export interface BreakdownRow {
  dimKind: string;
  dimId: string;
  label: string;
  metrics: Record<string, number | null>;
}

export interface CompareInfo {
  kind: Exclude<CompareMode, "none">;
  from?: string;
  to?: string;
  label: string;
}

export interface AiVsHuman {
  aiOnly: { conversations: number; leads: number; won: number; conversionRate: number | null };
  handedOff: { conversations: number; leads: number; won: number; conversionRate: number | null };
}

export interface FunnelResult {
  mode: "period" | "cohort";
  stages: FunnelStage[];
  note: string;
  /** Period mode: manually marked customers, reported apart from sales. */
  customerMarked?: number;
  truncated?: boolean;
}

export interface AnalyticsResult {
  tab: AnalyticsTab;
  range: ResolvedRange;
  compare: CompareInfo | null;
  accountId: string | null;
  metrics: Record<string, MetricValue>;
  series: SeriesPoint[];
  compareSeries?: SeriesPoint[];
  breakdown: BreakdownRow[];
  funnel?: FunnelResult;
  aiVsHuman?: AiVsHuman;
  accounts: Array<{ id: string; username: string }>;
  /** Plain-language caveats shown under the tiles. */
  notes: string[];
}

// ─── Rollup access ───────────────────────────────────────────────────────────

interface DailyRow {
  day: string;
  metric: string;
  dimKind: string;
  dimId: string;
  value: number;
}

async function loadRows(
  workspaceId: string,
  accountId: string | null,
  from: string,
  to: string,
  keys: string[],
  dim?: { kind: string; id: string } | { kinds: string[] }
): Promise<DailyRow[]> {
  const where: Record<string, unknown> = {
    workspaceId,
    instagramAccountId: accountId ?? "",
    day: { gte: dayColumn(from), lte: dayColumn(to) },
    metric: { in: keys },
  };
  if (!dim) where.dimKind = "";
  else if ("id" in dim) Object.assign(where, { dimKind: dim.kind, dimId: dim.id });
  else where.dimKind = { in: dim.kinds };
  const rows = (await prisma.analyticsDaily.findMany({ where })) as unknown as Array<{
    day: Date | string;
    metric: string;
    dimKind: string;
    dimId: string;
    value: unknown;
  }>;
  return rows.map((r) => ({ day: columnToKey(r.day), metric: r.metric, dimKind: r.dimKind, dimId: r.dimId, value: Number(r.value) || 0 }));
}

function sumBy(rows: DailyRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.metric] = (out[r.metric] ?? 0) + r.value;
  return out;
}

function deltaPct(value: number | null, compare: number | null): number | null {
  if (value === null || compare === null || compare === 0) return null;
  return Math.round(((value - compare) / Math.abs(compare)) * 1000) / 10;
}

function buildMetrics(tab: AnalyticsTab, current: Record<string, number>, previous: Record<string, number> | null): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {};
  for (const def of metricsForTab(tab)) {
    const value = current[def.key] ?? 0;
    const compare = previous ? (previous[def.key] ?? 0) : null;
    out[def.key] = { value, compare, deltaPct: deltaPct(value, compare), format: def.format, label: def.label };
  }
  for (const def of derivedForTab(tab)) {
    const value = deriveValue(def, current);
    const compare = previous ? deriveValue(def, previous) : null;
    out[def.key] = { value, compare, deltaPct: deltaPct(value, compare), derived: true, format: def.format, label: def.label };
  }
  return out;
}

function buildSeries(tab: AnalyticsTab, rows: DailyRow[], days: string[]): SeriesPoint[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const bucket = byDay.get(r.day) ?? {};
    bucket[r.metric] = (bucket[r.metric] ?? 0) + r.value;
    byDay.set(r.day, bucket);
  }
  const derived = derivedForTab(tab);
  return days.map((day) => {
    const values = byDay.get(day) ?? {};
    const point: SeriesPoint = { day };
    for (const def of metricsForTab(tab)) point[def.key] = values[def.key] ?? 0;
    for (const def of derived) point[def.key] = deriveValue(def, values);
    return point;
  });
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const REASON_LABELS: Record<string, string> = {
  SKIPPED_DEDUP: "Takroriy (dedup)",
  SKIPPED_RATE_LIMIT: "Soatlik limit",
  SKIPPED_PLAN_LIMIT: "Tarif limiti",
  SKIPPED_NO_MATCH: "Mos kelmadi",
  SKIPPED_WORKSPACE_SUSPENDED: "Workspace to'xtatilgan",
  TRIGGER_SKIPPED: "Trigger o'tkazib yubordi",
  BROADCAST_SKIPPED: "Broadcast o'tkazib yubordi",
};

export async function resolveLabels(workspaceId: string, pairs: Array<{ dimKind: string; dimId: string }>): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const ids = (kind: string) => [...new Set(pairs.filter((p) => p.dimKind === kind).map((p) => p.dimId))];
  const key = (kind: string, id: string) => `${kind}:${id}`;
  const client = prisma as unknown as Record<string, { findMany: (args: unknown) => Promise<Array<{ id: string; name?: string | null }>> }>;

  for (const [kind, model] of [
    ["automation", "automation"],
    ["trigger_campaign", "triggerCampaign"],
    ["broadcast", "crmBroadcast"],
  ] as const) {
    const wanted = ids(kind);
    if (wanted.length === 0) continue;
    const rows = await client[model].findMany({ where: { workspaceId, id: { in: wanted } } });
    for (const row of rows) if (row.name) labels.set(key(kind, row.id), row.name);
  }
  const pipelines = ids("pipeline");
  if (pipelines.length > 0) {
    const rows = await client.crmPipeline.findMany({ where: { workspaceId, id: { in: pipelines } } });
    for (const row of rows) if (row.name) labels.set(key("pipeline", row.id), row.name);
  }
  const members = ids("member");
  if (members.length > 0) {
    const rows = (await prisma.workspaceMember.findMany({ where: { workspaceId, id: { in: members } }, include: { user: true } })) as unknown as Array<{
      id: string;
      user: { name?: string | null; email?: string | null } | null;
    }>;
    for (const row of rows) labels.set(key("member", row.id), row.user?.name || row.user?.email || "A'zo");
  }
  for (const p of pairs) {
    if (labels.has(key(p.dimKind, p.dimId))) continue;
    if (p.dimKind === "reason") labels.set(key("reason", p.dimId), REASON_LABELS[p.dimId] ?? p.dimId);
    else if (p.dimKind === "kind") labels.set(key("kind", p.dimId), (JAVOBAI_USAGE_KIND_LABELS as Record<string, string>)[p.dimId] ?? PRODUCTION_USAGE_KIND_LABELS[p.dimId] ?? p.dimId);
    else if (p.dimKind === "error") labels.set(key("error", p.dimId), LLM_ERROR_LABELS[p.dimId] ?? p.dimId);
    else labels.set(key(p.dimKind, p.dimId), "O'chirilgan");
  }
  return labels;
}

// ─── Main read ───────────────────────────────────────────────────────────────

function rateOf(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null;
}

function buildAiVsHuman(values: Record<string, number>): AiVsHuman {
  const group = (name: "ai_only" | "handed_off") => {
    const conversations = values[`cohort.${name}.conversations`] ?? 0;
    const leads = values[`cohort.${name}.leads`] ?? 0;
    const won = values[`cohort.${name}.won`] ?? 0;
    return { conversations, leads, won, conversionRate: rateOf(won, leads) };
  };
  return { aiOnly: group("ai_only"), handedOff: group("handed_off") };
}

function buildPeriodFunnel(current: Record<string, number>, previous: Record<string, number> | null): FunnelResult {
  const first = current[FUNNEL_STAGES[0].metric] ?? 0;
  let before: number | null = null;
  const stages: FunnelStage[] = FUNNEL_STAGES.map((stage) => {
    const value = current[stage.metric] ?? 0;
    const compare = previous ? (previous[stage.metric] ?? 0) : null;
    // Period counts are not a tracked cohort, so a later stage can exceed an earlier one: no drop-off then.
    const raw = before !== null && before > 0 ? ((before - value) / before) * 100 : null;
    const row: FunnelStage = {
      key: stage.key,
      label: stage.label,
      value,
      compare,
      deltaPct: deltaPct(value, compare),
      pctOfFirst: first > 0 ? Math.round((value / first) * 1000) / 10 : null,
      dropOffPct: raw !== null && raw >= 0 ? Math.round(raw * 10) / 10 : null,
    };
    before = value;
    return row;
  });
  return { mode: "period", stages, note: FUNNEL_NOTE, customerMarked: current["sales.customer_marked"] ?? 0 };
}

export async function readAnalytics(workspaceId: string, params: ReadParams, now: Date = new Date()): Promise<{ ok: true; data: AnalyticsResult } | { ok: false; status: number; error: string }> {
  const resolved = resolveRange({ preset: params.preset, from: params.from, to: params.to }, now);
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };
  const range = resolved.range;
  const { tab } = params;
  const accountId = params.accountId;

  const accounts = ((await prisma.instagramAccount.findMany({ where: { workspaceId }, orderBy: { connectedAt: "desc" } })) as unknown as Array<{ id: string; username: string }>).map(
    (a) => ({ id: a.id, username: a.username })
  );
  if (accountId && !accounts.some((a) => a.id === accountId)) return { ok: false, status: 404, error: "Akkaunt topilmadi" };

  const days = listDayKeys(range.from, range.to);
  const keys = storedKeysForTab(tab);
  const notes: string[] = [];
  if (range.partial) notes.push("Bugungi kun hali tugamagan: ma'lumot har ~10 daqiqada yangilanadi.");

  // Which period (if any) sits next to the main one.
  let compare: CompareInfo | null = null;
  let compareRange: { from: string; to: string } | null = null;
  let dimCompare: { kind: DimKind; a: string; b: string } | null = null;
  if (params.compare === "previous") {
    compareRange = previousRange(range);
    compare = { kind: "previous", ...compareRange, label: "Oldingi davr" };
  } else if (params.compare === "custom") {
    const from = params.compareFrom;
    const to = params.compareTo ?? params.compareFrom;
    if (!isDayKey(from) || !isDayKey(to) || from > to) return { ok: false, status: 400, error: "Taqqoslash sanalari noto'g'ri" };
    if (listDayKeys(from, to).length > 366) return { ok: false, status: 400, error: "Taqqoslash oralig'i juda uzun" };
    compareRange = { from, to };
    compare = { kind: "custom", from, to, label: "Tanlangan davr" };
  } else if (params.compare === "dim") {
    if (!params.dim || !params.dimA || !params.dimB) return { ok: false, status: 400, error: "dim, dimA va dimB kerak" };
    dimCompare = { kind: params.dim, a: params.dimA, b: params.dimB };
    compare = { kind: "dim", label: "Boshqa kampaniya bilan" };
  } else if (params.compare === "ai_human") {
    compare = { kind: "ai_human", label: "AI va operator" };
  }

  // Current period: totals, or one slice when comparing two slices.
  const currentRows = dimCompare
    ? await loadRows(workspaceId, accountId ?? null, range.from, range.to, keys, { kind: dimCompare.kind, id: dimCompare.a })
    : await loadRows(workspaceId, accountId ?? null, range.from, range.to, keys);
  const current = sumBy(currentRows);

  let previous: Record<string, number> | null = null;
  let compareRows: DailyRow[] | null = null;
  if (compareRange) {
    compareRows = await loadRows(workspaceId, accountId ?? null, compareRange.from, compareRange.to, keys);
    previous = sumBy(compareRows);
  } else if (dimCompare) {
    compareRows = await loadRows(workspaceId, accountId ?? null, range.from, range.to, keys, { kind: dimCompare.kind, id: dimCompare.b });
    previous = sumBy(compareRows);
  }

  const data: AnalyticsResult = {
    tab,
    range,
    compare,
    accountId: accountId ?? null,
    metrics: tab === "funnel" ? {} : buildMetrics(tab, current, previous),
    series: buildSeries(tab, currentRows, days),
    breakdown: [],
    accounts,
    notes,
  };
  if (compareRows && compareRange) {
    data.compareSeries = buildSeries(tab, compareRows, listDayKeys(compareRange.from, compareRange.to));
  } else if (compareRows && dimCompare) {
    data.compareSeries = buildSeries(tab, compareRows, days);
  }

  // Breakdown by dimension (over the main period, not when already slicing).
  const dimKinds: DimKind[] = params.dim ? [params.dim] : defaultDimKinds(tab);
  if (dimKinds.length > 0 && !dimCompare) {
    const dimRows = await loadRows(workspaceId, accountId ?? null, range.from, range.to, keys, { kinds: dimKinds });
    const groups = new Map<string, { dimKind: string; dimId: string; values: Record<string, number> }>();
    for (const r of dimRows) {
      const k = `${r.dimKind}:${r.dimId}`;
      const g = groups.get(k) ?? { dimKind: r.dimKind, dimId: r.dimId, values: {} };
      g.values[r.metric] = (g.values[r.metric] ?? 0) + r.value;
      groups.set(k, g);
    }
    const labels = await resolveLabels(workspaceId, [...groups.values()]);
    const derived: DerivedDef[] = derivedForTab(tab);
    const tiles = metricsForTab(tab).map((m) => m.key);
    data.breakdown = [...groups.values()]
      .map((g) => {
        const metrics: Record<string, number | null> = {};
        for (const key of tiles) if (g.values[key] !== undefined) metrics[key] = g.values[key];
        for (const def of derived) {
          const v = deriveValue(def, g.values);
          if (v !== null) metrics[def.key] = v;
        }
        return { dimKind: g.dimKind, dimId: g.dimId, label: labels.get(`${g.dimKind}:${g.dimId}`) ?? g.dimId, metrics, weight: tiles.reduce((s, k) => s + (g.values[k] ?? 0), 0) };
      })
      .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
      .slice(0, 50)
      .map((row) => ({ dimKind: row.dimKind, dimId: row.dimId, label: row.label, metrics: row.metrics }));
  }

  if (tab === "funnel") {
    if (params.mode === "cohort") {
      const cohort = await computeCohortFunnel(workspaceId, { from: range.from, to: range.to, accountId: accountId ?? null });
      data.funnel = { mode: "cohort", stages: cohort.stages, note: cohort.note, truncated: cohort.truncated };
      data.notes.push("Kogorta rejimi: tanlangan davrda birinchi marta yozgan odamlar bosqichma-bosqich kuzatiladi (jonli hisob).");
    } else {
      data.funnel = buildPeriodFunnel(current, previous);
    }
  }

  if (tab === "ai") {
    const cohortRows = await loadRows(workspaceId, accountId ?? null, range.from, range.to, [...COHORT_METRICS]);
    data.aiVsHuman = buildAiVsHuman(sumBy(cohortRows));
  }
  return { ok: true, data };
}
