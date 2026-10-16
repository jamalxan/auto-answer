"use client";

/**
 * ETAP 10 - Analytics, the developer screen. Tabs (Kampaniya / AI / Sotuv /
 * Funnel / KPI) and the whole filter state live in the URL, so a link opens the
 * same view. Everything on the first four tabs comes from one GET (rollups);
 * KPI polls its own endpoint.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { DevBadge, EmptyState, inputClass, secondaryButton } from "@/components/developer/ui";
import { formatMetric, metricDef, type MetricFormat } from "@/lib/analytics/catalog";
import { FunnelBars, TrendLineChart, mergeCompare, type ChartPoint } from "./charts";
import KpiTab from "./kpi-tab";
import {
  ANALYTICS_API,
  DEFAULT_CHART_KEYS,
  PRESETS,
  TABS,
  formatDelta,
  requestJson,
  type AnalyticsResult,
  type DashboardTab,
  type Preset,
} from "./shared";

function Stat({
  label,
  value,
  compare,
  deltaPct,
  hint,
  inverse,
}: {
  label: string;
  value: string;
  compare?: string | null;
  deltaPct?: number | null;
  hint?: string;
  /** A rise is bad (errors, cost). */
  inverse?: boolean;
}) {
  const delta = deltaPct === null || deltaPct === undefined ? "" : formatDelta(deltaPct);
  const good = deltaPct === null || deltaPct === undefined || deltaPct === 0 ? null : inverse ? deltaPct < 0 : deltaPct > 0;
  return (
    <div className="panel min-w-0 rounded-xl px-4 py-3" title={hint}>
      <p className="label-mono truncate text-[10px] font-semibold text-muted">{label}</p>
      <p className="mt-1 truncate text-xl font-bold text-foreground">{value}</p>
      {(delta || compare) && (
        <p className="mt-0.5 truncate text-[11px] text-muted">
          {delta && <span className={good === null ? "" : good ? "text-success" : "text-error"}>{delta}</span>}
          {compare ? <span>{delta ? " · " : ""}oldin {compare}</span> : null}
        </p>
      )}
    </div>
  );
}

const INVERSE_KEYS = new Set(["campaign.failed", "campaign.skipped", "campaign.failure_rate", "ai.failed_calls", "ai.cost_usd", "ai.llm_errors", "ai.blocked_replies", "ai.fallbacks", "sales.lost", "ai.handoff", "ai.handoff_rate", "ai.avg_latency_ms", "ai.avg_handoff_wait_ms"]);

export default function AnalyticsDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: DashboardTab = TABS.some(([key]) => key === tabParam) ? (tabParam as DashboardTab) : "campaign";
  const presetParam = searchParams.get("preset");
  const preset: Preset = PRESETS.some(([key]) => key === presetParam) ? (presetParam as Preset) : "7d";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const accountId = searchParams.get("accountId") ?? "";
  const compare = searchParams.get("compare") ?? "previous";
  const compareFrom = searchParams.get("compareFrom") ?? "";
  const compareTo = searchParams.get("compareTo") ?? "";
  const mode = searchParams.get("mode") === "cohort" ? "cohort" : "period";
  const dim = searchParams.get("dim") ?? "";

  const [data, setData] = useState<AnalyticsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      router.replace(`/developer/analytics?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const query = useMemo(() => {
    const params = new URLSearchParams({ tab, preset, compare, mode });
    if (preset === "custom") {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    }
    if (accountId) params.set("accountId", accountId);
    if (dim) params.set("dim", dim);
    if (compare === "custom") {
      if (compareFrom) params.set("compareFrom", compareFrom);
      if (compareTo) params.set("compareTo", compareTo);
    }
    return params.toString();
  }, [tab, preset, compare, mode, from, to, accountId, dim, compareFrom, compareTo]);

  const load = useCallback(async () => {
    if (tab === "kpi") return;
    const mine = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const res = await requestJson<AnalyticsResult>(`${ANALYTICS_API}?${query}`);
      if (mine !== seq.current) return;
      if (res.ok) setData(res.data);
      else setFailure(res.error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [tab, query]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  const accounts = data?.accounts ?? [];
  const chartKeys = (DEFAULT_CHART_KEYS[tab] ?? []).filter((key) => !hidden.has(key));
  const tileKeys = data ? Object.keys(data.metrics) : [];
  const series = chartKeys.map((key) => ({ key, label: metricDef(key)?.label ?? key, format: (metricDef(key)?.format ?? "int") as MetricFormat }));
  const chartData = data ? mergeCompare(data.series as ChartPoint[], data.compareSeries as ChartPoint[] | undefined, chartKeys) : [];
  const hasData = data ? data.series.some((p) => Object.entries(p).some(([k, v]) => k !== "day" && typeof v === "number" && v > 0)) : false;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Analitika</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Kampaniya, AI va sotuv ko&apos;rsatkichlari, funnel va jonli KPI. Kunlar Asia/Tashkent bo&apos;yicha.
          </p>
        </div>
        {tab !== "kpi" && (
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </button>
        )}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist" aria-label="Analitika bo'limlari">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => update({ tab: key })}
            className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "kpi" ? (
        <KpiTab />
      ) : (
        <>
          {/* Range bar */}
          <div className="panel space-y-3 rounded-xl p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Davr">
                {PRESETS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={preset === key}
                    onClick={() => update({ preset: key, ...(key === "custom" ? {} : { from: null, to: null }) })}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium ${preset === key ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {preset === "custom" && (
                <div className="flex flex-wrap items-center gap-2">
                  <input type="date" aria-label="Boshlanish sanasi" className={`${inputClass} w-auto`} value={from} onChange={(e) => update({ from: e.target.value })} />
                  <span className="text-muted">—</span>
                  <input type="date" aria-label="Tugash sanasi" className={`${inputClass} w-auto`} value={to} onChange={(e) => update({ to: e.target.value })} />
                </div>
              )}
              <select aria-label="Akkaunt" className={`${inputClass} w-auto`} value={accountId} onChange={(e) => update({ accountId: e.target.value })}>
                <option value="">Barcha akkauntlar</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.username}
                  </option>
                ))}
              </select>
              <select aria-label="Taqqoslash" className={`${inputClass} w-auto`} value={compare} onChange={(e) => update({ compare: e.target.value })}>
                <option value="previous">Oldingi davr bilan</option>
                <option value="custom">Tanlangan davr bilan</option>
                <option value="none">Taqqoslamaslik</option>
                {tab === "ai" && <option value="ai_human">AI va operator</option>}
              </select>
              {tab === "funnel" && (
                <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Funnel rejimi">
                  {(
                    [
                      ["period", "Davr"],
                      ["cohort", "Kogorta"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={mode === key}
                      onClick={() => update({ mode: key })}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === key ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {compare === "custom" && (
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span>Taqqoslash:</span>
                <input type="date" aria-label="Taqqoslash boshlanishi" className={`${inputClass} w-auto`} value={compareFrom} onChange={(e) => update({ compareFrom: e.target.value })} />
                <span>—</span>
                <input type="date" aria-label="Taqqoslash tugashi" className={`${inputClass} w-auto`} value={compareTo} onChange={(e) => update({ compareTo: e.target.value })} />
              </div>
            )}
            {data && (
              <p className="text-xs text-muted">
                {data.range.from === data.range.to ? data.range.from : `${data.range.from} — ${data.range.to}`} · {data.range.days} kun
                {data.compare?.from && ` · taqqos: ${data.compare.from === data.compare.to ? data.compare.from : `${data.compare.from} — ${data.compare.to}`}`}
              </p>
            )}
          </div>

          {failure && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
              <span className="min-w-0 break-words">{failure}</span>
              <button type="button" className={secondaryButton} onClick={() => void load()}>
                Qayta urinish
              </button>
            </div>
          )}

          {data?.range.partial && <Notice tone="info">Bugungi kun hali tugamagan: ma&apos;lumot har ~10 daqiqada yangilanadi, yakuniy raqamlar ertaga aniqlashadi.</Notice>}

          {!data && loading && <p className="text-sm text-muted">Yuklanmoqda…</p>}

          {data && tab !== "funnel" && (
            <>
              {!hasData && (
                <div className="panel rounded-xl">
                  <EmptyState
                    title="Bu davrda ma'lumot yo'q"
                    body="Rollup'lar har 10 daqiqada yangilanadi. Eski kunlar uchun KPI bo'limidagi «Backfill» tugmasini ishlating."
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {tileKeys.map((key) => {
                  const m = data.metrics[key];
                  return (
                    <Stat
                      key={key}
                      label={m.label}
                      value={formatMetric(m.value, m.format)}
                      compare={m.compare !== null && data.compare ? formatMetric(m.compare, m.format) : null}
                      deltaPct={m.deltaPct}
                      inverse={INVERSE_KEYS.has(key)}
                      hint={metricDef(key)?.hint}
                    />
                  );
                })}
              </div>

              {hasData && series.length > 0 && (
                <div className="panel rounded-xl p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    {(DEFAULT_CHART_KEYS[tab] ?? []).map((key) => {
                      const off = hidden.has(key);
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={!off}
                          onClick={() =>
                            setHidden((prev) => {
                              const next = new Set(prev);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${off ? "border-border text-muted" : "border-accent/40 bg-accent/10 text-foreground"}`}
                        >
                          {metricDef(key)?.label ?? key}
                        </button>
                      );
                    })}
                  </div>
                  <TrendLineChart data={chartData} series={series} withCompare={Boolean(data.compareSeries)} label="Kunlik dinamika" />
                </div>
              )}

              {tab === "ai" && data.aiVsHuman && <AiVsHumanCard value={data.aiVsHuman} />}

              <BreakdownTable data={data} />
              {data.notes.filter((n) => !n.startsWith("Bugungi")).map((note) => (
                <p key={note} className="text-xs text-muted">
                  {note}
                </p>
              ))}
            </>
          )}

          {data && tab === "funnel" && data.funnel && (
            <div className="panel space-y-4 rounded-xl p-4 sm:p-6">
              <div>
                <h2 className="text-sm font-semibold text-foreground">{data.funnel.mode === "cohort" ? "Kogorta funnel" : "Davr funnel"}</h2>
                <p className="mt-1 text-xs text-muted">{data.funnel.note}</p>
              </div>
              {data.funnel.stages.every((s) => s.value === 0) ? (
                <EmptyState title="Bu davrda funnel ma'lumoti yo'q" />
              ) : (
                <FunnelBars stages={data.funnel.stages} />
              )}
              {data.funnel.mode === "period" && (data.funnel.customerMarked ?? 0) > 0 && (
                <p className="text-xs text-muted">
                  Qo&apos;lda «Mijoz» deb belgilanganlar (bitimsiz): {data.funnel.customerMarked} — sotuvlarga qo&apos;shilmagan.
                </p>
              )}
              {data.funnel.truncated && <Notice tone="warning">Kogorta juda katta: birinchi 20 000 kontakt hisoblandi.</Notice>}
              {data.compare?.kind === "previous" && data.funnel.mode === "period" && (
                <ul className="grid gap-1 text-xs text-muted sm:grid-cols-2">
                  {data.funnel.stages.map((s) => (
                    <li key={s.key}>
                      {s.label}: {s.value.toLocaleString("en-US")} <span className="text-muted">(oldin {s.compare?.toLocaleString("en-US") ?? "—"}</span>
                      {s.deltaPct !== null && <span className={s.deltaPct >= 0 ? "text-success" : "text-error"}> {formatDelta(s.deltaPct)}</span>})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AiVsHumanCard({ value }: { value: NonNullable<AnalyticsResult["aiVsHuman"]> }) {
  const rows = [
    ["Faqat AI", value.aiOnly],
    ["Operatorga topshirilgan", value.handedOff],
  ] as const;
  return (
    <div className="panel rounded-xl p-4">
      <h2 className="text-sm font-semibold text-foreground">AI va operator</h2>
      <p className="mt-1 text-xs text-muted">AI boshlagan suhbatlar: operator aralashganlari va aralashmaganlari (kechasi yangilanadi).</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {rows.map(([label, v]) => (
          <div key={label} className="rounded-lg border border-border px-3 py-2 text-sm">
            <p className="font-medium text-foreground">{label}</p>
            <p className="mt-1 text-muted">
              Suhbat {v.conversations} · Lid {v.leads} · Sotuv {v.won} · Konversiya {formatMetric(v.conversionRate, "pct")}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function BreakdownTable({ data }: { data: AnalyticsResult }) {
  if (data.breakdown.length === 0) return null;
  const keys = Object.keys(data.metrics).filter((k) => data.breakdown.some((row) => row.metrics[k] !== undefined && row.metrics[k] !== null)).slice(0, 5);
  return (
    <div className="panel overflow-hidden rounded-xl">
      <div className="px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Taqsimot</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="text-[11px] uppercase text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">Nomi</th>
              {keys.map((k) => (
                <th key={k} className="px-3 py-2 text-right font-semibold">
                  {data.metrics[k].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.breakdown.map((row) => (
              <tr key={`${row.dimKind}:${row.dimId}`} className="border-t border-border">
                <td className="max-w-[16rem] truncate px-4 py-2 text-foreground">
                  {row.label}
                  <span className="ml-2 text-[10px] text-muted">{row.dimKind}</span>
                </td>
                {keys.map((k) => (
                  <td key={k} className="px-3 py-2 text-right tabular-nums text-muted">
                    {formatMetric(row.metrics[k], data.metrics[k].format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
