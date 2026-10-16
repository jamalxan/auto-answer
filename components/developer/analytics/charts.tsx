"use client";

/**
 * Chart wrappers for the Analytics screen (recharts 3, same look as
 * components/follower-chart.tsx): no animation, a ResponsiveContainer, colour
 * tokens from the app theme, a compact tooltip, and a table fallback for
 * assistive tech through aria-label + the visible numbers in the tiles.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMetric, type MetricFormat } from "@/lib/analytics/catalog";
import { shortDay } from "./shared";

const GRID_COLOR = "rgba(180, 182, 255, 0.14)";
const AXIS_TEXT = "#a19fca";
export const SERIES_COLORS = ["#00f0b5", "#ffb01f", "#8b8cff", "#ff5d4d", "#4cc9f0", "#f472b6"];

export interface ChartSeries {
  key: string;
  label: string;
  format?: MetricFormat;
}

export type ChartPoint = { day: string } & Record<string, number | string | null>;

/**
 * Lays the comparison period over the main one by position (day 1 of the
 * comparison under day 1 of the range), as `<key>__cmp` columns.
 */
export function mergeCompare(series: ChartPoint[], compareSeries: ChartPoint[] | undefined, keys: string[]): ChartPoint[] {
  if (!compareSeries?.length) return series;
  return series.map((point, i) => {
    const other = compareSeries[i];
    const merged: ChartPoint = { ...point };
    for (const key of keys) merged[`${key}__cmp`] = other ? (other[key] ?? null) : null;
    return merged;
  });
}

function ChartTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | string | null; color?: string }>;
  label?: string | number;
  series: ChartSeries[];
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-muted">{typeof label === "string" ? shortDay(label) : label}</p>
      {payload.map((item) => {
        const key = String(item.dataKey ?? "");
        const base = key.replace(/__cmp$/, "");
        const def = series.find((s) => s.key === base);
        if (!def) return null;
        return (
          <p key={key} className="mt-1 flex items-center gap-2 text-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: item.color }} aria-hidden="true" />
            <span className="text-muted">
              {def.label}
              {key.endsWith("__cmp") ? " (taqqos)" : ""}
            </span>
            <span className="font-semibold">{formatMetric(typeof item.value === "number" ? item.value : null, def.format ?? "int")}</span>
          </p>
        );
      })}
    </div>
  );
}

function axisFormatter(value: number | string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n * 100) / 100);
}

export function TrendLineChart({
  data,
  series,
  withCompare = false,
  height = 240,
  label,
}: {
  data: ChartPoint[];
  series: ChartSeries[];
  withCompare?: boolean;
  height?: number;
  label: string;
}) {
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: AXIS_TEXT, fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tickFormatter={axisFormatter} tick={{ fill: AXIS_TEXT, fontSize: 11 }} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
          <Tooltip content={<ChartTooltip series={series} />} cursor={{ stroke: GRID_COLOR }} />
          {series.map((s, i) => (
            <Line key={s.key} type="monotone" dataKey={s.key} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
          ))}
          {withCompare &&
            series.map((s, i) => (
              <Line
                key={`${s.key}__cmp`}
                type="monotone"
                dataKey={`${s.key}__cmp`}
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeOpacity={0.55}
                strokeDasharray="4 4"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendBarChart({
  data,
  series,
  height = 240,
  label,
}: {
  data: ChartPoint[];
  series: ChartSeries[];
  height?: number;
  label: string;
}) {
  return (
    <div style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fill: AXIS_TEXT, fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tickFormatter={axisFormatter} tick={{ fill: AXIS_TEXT, fontSize: 11 }} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
          <Tooltip content={<ChartTooltip series={series} />} cursor={{ fill: GRID_COLOR }} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A 10-point sparkline (no axes) for the messages-per-minute tile. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const data = values.map((value, i) => ({ day: String(i), value }));
  return (
    <div style={{ height: 40 }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={[0, "dataMax"]} />
          <Line type="monotone" dataKey="value" stroke={SERIES_COLORS[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface FunnelBarStage {
  key: string;
  label: string;
  value: number;
  compare: number | null;
  deltaPct: number | null;
  pctOfFirst: number | null;
  dropOffPct: number | null;
}

/** Horizontal funnel: one bar per stage, width = share of the first stage, drop-off between bars. */
export function FunnelBars({ stages }: { stages: FunnelBarStage[] }) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <ol className="space-y-3">
      {stages.map((stage, i) => (
        <li key={stage.key}>
          {i > 0 && stage.dropOffPct !== null && (
            <p className="mb-1 pl-1 text-[11px] text-muted">
              <span aria-hidden="true">↓ </span>
              {stage.dropOffPct.toFixed(1).replace(/\.0$/, "")}% yo&apos;qoldi
            </p>
          )}
          <div className="flex items-center gap-3">
            <p className="w-28 shrink-0 text-xs font-medium text-foreground sm:w-40">{stage.label}</p>
            <div className="h-7 min-w-0 flex-1 overflow-hidden rounded bg-surface-hover/60">
              <div
                className="flex h-full items-center rounded bg-accent/80 px-2 text-xs font-bold text-background"
                style={{ width: `${Math.max(3, (stage.value / max) * 100)}%`, opacity: 1 - i * 0.08 }}
              >
                {stage.value.toLocaleString("en-US")}
              </div>
            </div>
            <p className="w-12 shrink-0 text-right text-xs tabular-nums text-muted">
              {stage.pctOfFirst === null ? "—" : `${stage.pctOfFirst.toFixed(1).replace(/\.0$/, "")}%`}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
