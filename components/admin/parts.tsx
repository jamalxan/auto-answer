/**
 * Building blocks of the admin panel: page title, KPI tile with its 30-day
 * change, network mark, status pill and the 30-day activity chart. Server
 * components only; they render brand primitives (.panel, .inset, .chip).
 */

import type { ReactNode } from "react";
import type { DayPoint, Network, Trend } from "@/lib/admin/overview";
import { NETWORK_LABEL } from "@/lib/admin/copy";

export function AdminTitle({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="display wrap-anywhere text-[1.6rem] text-white sm:text-[2rem]">{title}</h1>
        {sub && <p className="mt-2 text-[15px] leading-6 text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, sub, action, children, className = "" }: { title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel min-w-0 rounded-3xl p-5 sm:p-6 ${className}`}>
      {(title || action) && (
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-base font-bold text-white">{title}</h2>}
            {sub && <p className="mt-1 text-sm leading-6 text-muted">{sub}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Percent change, or null when there is nothing to compare with. */
export function changePct(t: Trend): number | null {
  if (t.previous === 0) return null;
  return Math.round(((t.current - t.previous) / t.previous) * 100);
}

export function Kpi({
  label,
  value,
  trend,
  vsLabel,
  noPrevLabel,
  foot,
  unit,
  tone = "default",
}: {
  label: string;
  value: string;
  /** Small suffix after the value ("so'm"). */
  unit?: string;
  trend?: Trend;
  vsLabel?: string;
  noPrevLabel?: string;
  foot?: ReactNode;
  tone?: "default" | "lime";
}) {
  const pct = trend ? changePct(trend) : null;
  return (
    <div className={`rounded-3xl p-5 ${tone === "lime" ? "bg-lime text-midnight" : "panel"}`}>
      <p className={`text-sm font-medium ${tone === "lime" ? "text-midnight/70" : "text-muted"}`}>{label}</p>
      <p className={`display mt-3 text-[1.75rem] leading-none tabular-nums ${tone === "lime" ? "text-midnight" : "text-white"}`}>
        {value}
        {unit && <span className="ml-1.5 font-sans text-sm font-semibold">{unit}</span>}
      </p>
      {trend && (
        <p className={`mt-3 text-xs ${tone === "lime" ? "text-midnight/70" : "text-muted"}`}>
          {pct === null ? (
            trend.current > 0 ? noPrevLabel : "—"
          ) : (
            <>
              <span className={`font-semibold ${pct > 0 ? (tone === "lime" ? "text-midnight" : "text-lime") : pct < 0 ? "text-error" : ""}`}>
                {pct > 0 ? "▲" : pct < 0 ? "▼" : "•"} {Math.abs(pct)}%
              </span>{" "}
              {vsLabel}
            </>
          )}
        </p>
      )}
      {foot && <p className={`mt-1 text-xs ${tone === "lime" ? "text-midnight/70" : "text-muted"}`}>{foot}</p>}
    </div>
  );
}

const NETWORK_TINT: Record<Network, string> = {
  instagram: "bg-[#e1306c] text-white",
  facebook: "bg-[#1877f2] text-white",
  threads: "bg-white text-midnight",
  youtube: "bg-[#ff0000] text-white",
  telegram: "bg-[#29a9eb] text-white",
};
const NETWORK_INITIAL: Record<Network, string> = { instagram: "IG", facebook: "FB", threads: "@", youtube: "YT", telegram: "TG" };

export function NetworkMark({ network, size = "md" }: { network: Network; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-6 w-6 text-[9px]" : "h-9 w-9 text-[11px]";
  return (
    <span className={`grid shrink-0 place-items-center rounded-full font-bold ${box} ${NETWORK_TINT[network]}`} title={NETWORK_LABEL[network]} aria-label={NETWORK_LABEL[network]}>
      {NETWORK_INITIAL[network]}
    </span>
  );
}

export function StatusPill({ tone, children }: { tone: "ok" | "bad" | "warn" | "muted"; children: ReactNode }) {
  const cls = {
    ok: "bg-lime/15 text-lime",
    bad: "bg-error/15 text-error",
    warn: "bg-warning/15 text-warning",
    muted: "bg-white/8 text-muted",
  }[tone];
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>{children}</span>;
}

/**
 * 30 daily columns: DMs as the violet bar, a lime dot above it on days with
 * a new customer. Pure SVG-free markup so it scales with the card.
 */
export function ActivityChart({ data, dmsLabel, signupsLabel, emptyLabel, locale }: { data: DayPoint[]; dmsLabel: string; signupsLabel: string; emptyLabel: string; locale: string }) {
  const max = Math.max(1, ...data.map((d) => d.dms));
  const empty = data.every((d) => d.dms === 0 && d.signups === 0);
  const fmtDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { day: "numeric", month: "short" });
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-violet" /> {dmsLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-lime" /> {signupsLabel}
        </span>
      </div>
      {empty ? (
        <p className="inset grid h-40 place-items-center text-sm text-muted">{emptyLabel}</p>
      ) : (
        <div className="flex h-44 items-end gap-[3px] sm:gap-1" role="img" aria-label={`${dmsLabel} / ${signupsLabel}`}>
          {data.map((d) => (
            <div key={d.day} className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={`${fmtDay(d.day)}: ${d.dms} ${dmsLabel}, ${d.signups} ${signupsLabel}`}>
              {d.signups > 0 && <span className="mb-1 h-1.5 w-1.5 rounded-full bg-lime" />}
              <div className="w-full rounded-t-[3px] bg-violet/80 transition-colors group-hover:bg-violet" style={{ height: `${d.dms === 0 ? 2 : Math.max(4, (d.dms / max) * 100)}%`, opacity: d.dms === 0 ? 0.25 : 1 }} />
            </div>
          ))}
        </div>
      )}
      {!empty && (
        <div className="mt-2 flex justify-between text-[11px] text-muted">
          <span>{fmtDay(data[0].day)}</span>
          <span>{fmtDay(data[Math.floor(data.length / 2)].day)}</span>
          <span>{fmtDay(data[data.length - 1].day)}</span>
        </div>
      )}
    </div>
  );
}
