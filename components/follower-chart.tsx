"use client";

/**
 * Followers Over Time
 *
 * Single-series line chart over stored daily snapshots. Deliberately separate
 * from the Overview stat tiles: those sum the selected posts, while this is an
 * account-level total that ignores the post range.
 *
 * History depth is limited by what has been snapshotted — Instagram only serves
 * ~30 days of account insights, so earlier days exist only if this instance was
 * already running then.
 */

import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLanguage } from "@/components/language-provider";
import { formatShortMonthDay } from "@/lib/i18n/format-date";
import type { Locale } from "@/lib/i18n/config";

export interface FollowerChartPoint {
  date: string;
  followers: number;
  delta: number | null;
}

// Colors read against the panel surface (#13143d): the lime series line is the
// brand accent, the grid is a faint white step and axis text is the muted
// token. See globals.css.
const SERIES_COLOR = "#d4ff3a";
const GRID_COLOR = "rgba(255, 255, 255, 0.1)";
const AXIS_TEXT = "#a7aacb";
const SURFACE = "#13143d";

function formatCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatDay(iso: string, locale: Locale): string {
  return formatShortMonthDay(new Date(`${iso}T00:00:00Z`), locale, { utc: true });
}

function formatSigned(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toLocaleString()}`;
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: FollowerChartPoint }>;
}) {
  const { t, locale } = useLanguage();
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;

  return (
    <div className="rounded-2xl bg-midnight px-3 py-2 text-xs shadow-lg">
      <p className="text-muted">{formatDay(point.date, locale)}</p>
      <p className="mt-1 font-semibold text-white">
        {point.followers.toLocaleString()} {t.followerChart.tooltipFollowersSuffix}
      </p>
      {point.delta !== null && point.delta !== 0 && (
        <p className={point.delta > 0 ? "text-lime" : "text-error"}>
          {formatSigned(point.delta)} {t.followerChart.tooltipThatDay}
        </p>
      )}
    </div>
  );
}

export default function FollowerChart({
  data,
  followers,
}: {
  data: FollowerChartPoint[];
  followers: number | null;
}) {
  const { t, locale } = useLanguage();
  const [showTable, setShowTable] = useState(false);

  const current = followers ?? data.at(-1)?.followers ?? null;

  // Net change across the whole visible window, shown once in the header rather
  // than labelling every point.
  const net =
    data.length > 1 ? data[data.length - 1].followers - data[0].followers : null;

  return (
    <div className="panel rounded-3xl p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-white">
            {t.followerChart.title}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {current === null
              ? t.followerChart.unavailable
              : t.followerChart.currentNow(current.toLocaleString())}
            {net !== null && (
              <>
                {" · "}
                <span className={net >= 0 ? "text-lime" : "text-error"}>
                  {formatSigned(net)}
                </span>{" "}
                {t.followerChart.overDays(data.length)}
              </>
            )}
          </p>
        </div>
        {data.length > 1 && (
          <button
            type="button"
            onClick={() => setShowTable((v) => !v)}
            className="btn btn-sm btn-ghost"
          >
            {showTable ? t.followerChart.showChart : t.followerChart.showTable}
          </button>
        )}
      </div>

      {data.length < 2 ? (
        <div className="inset mt-6 p-6 text-center">
          <p className="text-sm font-semibold text-white">{t.followerChart.collecting}</p>
          <p className="mt-1 text-sm text-muted">
            {data.length === 0
              ? t.followerChart.noSnapshots
              : t.followerChart.oneDayRecorded}{" "}
            {t.followerChart.pointAddedDaily}
          </p>
        </div>
      ) : showTable ? (
        <div className="mt-4 max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-muted">
                <th className="py-2 pr-4 font-semibold">{t.followerChart.colDate}</th>
                <th className="py-2 px-3 font-semibold text-right">{t.followerChart.colFollowers}</th>
                <th className="py-2 pl-3 font-semibold text-right">{t.followerChart.colChange}</th>
              </tr>
            </thead>
            <tbody className="[&>tr:nth-child(even)]:bg-midnight/40">
              {[...data].reverse().map((p) => (
                <tr key={p.date}>
                  <td className="py-2 pr-4 text-white">
                    {formatDay(p.date, locale)}
                  </td>
                  <td className="py-2 px-3 text-right text-muted">
                    {p.followers.toLocaleString()}
                  </td>
                  <td className="py-2 pl-3 text-right text-muted">
                    {p.delta === null ? "—" : formatSigned(p.delta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-6 h-56 sm:h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                vertical={false}
                stroke={GRID_COLOR}
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="date"
                tickFormatter={(d) => formatDay(d, locale)}
                tick={{ fill: AXIS_TEXT, fontSize: 12 }}
                stroke={GRID_COLOR}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={formatCompact}
                tick={{ fill: AXIS_TEXT, fontSize: 12 }}
                stroke={GRID_COLOR}
                tickLine={false}
                width={52}
                // Followers rarely start near zero, so a zero baseline would
                // flatten the line into a straight edge.
                domain={["dataMin - 5", "dataMax + 5"]}
              />
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ stroke: GRID_COLOR, strokeWidth: 1 }}
              />
              <Line
                type="monotone"
                dataKey="followers"
                stroke={SERIES_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: SERIES_COLOR, stroke: SURFACE, strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
