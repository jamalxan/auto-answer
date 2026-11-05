"use client";

/**
 * Umumiy ko'rinish → "Umumiy": every connected network side by side. Totals
 * across networks, one tile per network (opens its detail), then one row per
 * account (opens that account's detail). Numbers we cannot get (Telegram
 * views, a network without the statistics permission) show as "—" with the
 * reason, never as a zero.
 */

import { useEffect, useState } from "react";
import { BRAND_COLOR } from "@/components/brand-icons";
import { ChannelMark, NETWORK_NAME } from "@/components/channels/ui";
import { EmptyState } from "@/components/ui/page";
import StatCard from "@/components/stat-card";
import type { AccountStats, Metrics, NetworkStats, StatsNetwork } from "@/lib/analytics/network-stats";
import { requestJson } from "@/lib/request-json";
import { RangePicker, engagement, fmt, type Range } from "./format";

const ORDER: StatsNetwork[] = ["instagram", "facebook", "threads", "youtube", "telegram"];

export default function NetworkStatsView({ days, onDays, onOpen }: { days: Range; onDays: (d: Range) => void; onOpen: (network: StatsNetwork, accountId?: string) => void }) {
  const [result, setResult] = useState<{ days: Range; data: NetworkStats | null; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    requestJson<NetworkStats>(`/api/analytics/networks?days=${days}`).then((res) => {
      if (!cancelled) setResult({ days, data: res.ok ? res.data : null, error: res.ok ? null : res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const loading = !result || result.days !== days;
  const data = result?.data ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm leading-6 text-muted">Barcha ulangan tarmoqlar bir joyda. Batafsil ko&apos;rish uchun tarmoq yoki akkauntni bosing.</p>
        <RangePicker value={days} onChange={onDays} />
      </div>

      {result?.error && !loading ? (
        <div className="panel rounded-3xl p-6 text-sm text-error">{result.error}</div>
      ) : loading || !data ? (
        <Skeleton />
      ) : data.accounts.length === 0 ? (
        <div className="panel rounded-3xl p-6">
          <EmptyState title="Hali tarmoq ulanmagan" body="Kanallar bo'limida Instagram, Facebook, Threads, YouTube yoki Telegram'ni ulang: statistika shu yerda paydo bo'ladi." />
          <div className="mt-4 text-center">
            <a href="/channels" className="btn btn-sm btn-lime">
              Kanallarga o&apos;tish
            </a>
          </div>
        </div>
      ) : (
        <Loaded data={data} onOpen={onOpen} />
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Yuklanmoqda">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="panel h-[104px] animate-pulse rounded-2xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {ORDER.map((n) => (
          <div key={n} className="panel h-48 animate-pulse rounded-3xl" />
        ))}
      </div>
    </div>
  );
}

function Loaded({ data, onOpen }: { data: NetworkStats; onOpen: (network: StatsNetwork, accountId?: string) => void }) {
  const all = ORDER.map((n) => data.totals[n]);
  const sum = (pick: (t: (typeof all)[number]) => number | null | undefined) => {
    const vals = all.map(pick).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const published = sum((t) => t.published) ?? 0;
  const views = sum((t) => t.metrics?.views);
  const reactions = sum((t) => engagement(t.metrics));
  const inbound = sum((t) => t.inbound) ?? 0;
  const replies = sum((t) => t.replies) ?? 0;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Chiqqan postlar" value={fmt(published)} />
        <StatCard label="Ko'rishlar" value={fmt(views)} />
        <StatCard label="Reaksiyalar" value={fmt(reactions)} />
        <StatCard label="Kelgan / javob berilgan" value={`${fmt(inbound)} / ${fmt(replies)}`} />
      </div>

      {published > 0 && (
        <div className="panel rounded-3xl p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold text-white">Postlar tarmoqlar bo&apos;yicha</h2>
            <span className="text-xs text-muted">oxirgi {data.days} kun</span>
          </div>
          <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-midnight" role="img" aria-label={ORDER.map((n) => `${NETWORK_NAME[n]} ${data.totals[n].published}`).join(", ")}>
            {ORDER.filter((n) => data.totals[n].published > 0).map((n) => (
              <span key={n} style={{ width: `${(data.totals[n].published / published) * 100}%`, background: n === "instagram" ? "linear-gradient(90deg,#FF543E,#C837AB)" : BRAND_COLOR[n] }} />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
            {ORDER.filter((n) => data.totals[n].published > 0).map((n) => (
              <li key={n} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: n === "instagram" ? "#E4405F" : BRAND_COLOR[n] }} />
                {NETWORK_NAME[n]} <span className="font-semibold tabular-nums text-white">{Math.round((data.totals[n].published / published) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {ORDER.map((n) => (
          <NetworkTile key={n} network={n} totals={data.totals[n]} onOpen={() => onOpen(n)} />
        ))}
      </div>

      <div className="panel rounded-3xl p-5 sm:p-6">
        <h2 className="mb-4 text-base font-bold text-white">Akkauntlar bo&apos;yicha</h2>
        <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-2 pr-4 font-semibold">Akkaunt</th>
                <th className="px-3 py-2 text-right font-semibold">Chiqdi</th>
                <th className="px-3 py-2 text-right font-semibold">Xato</th>
                <th className="px-3 py-2 text-right font-semibold">Ko&apos;rishlar</th>
                <th className="px-3 py-2 text-right font-semibold">Layklar</th>
                <th className="px-3 py-2 text-right font-semibold">Izohlar</th>
                <th className="px-3 py-2 text-right font-semibold">Ulashish</th>
                <th className="px-3 py-2 text-right font-semibold" title="Kelgan komment va xabarlar / javob berilgani">
                  Kelgan / javob
                </th>
              </tr>
            </thead>
            <tbody className="[&>tr:nth-child(even)]:bg-midnight/40">
              {ORDER.flatMap((n) => data.accounts.filter((a) => a.network === n)).map((a) => (
                <AccountRow key={`${a.network}:${a.id}`} a={a} onOpen={() => onOpen(a.network, a.id)} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-5 text-muted">
          Instagram ko&apos;rsatkichlari Kontent intellekti yig&apos;gan postlardan olinadi. Facebook, Threads va YouTube ko&apos;rsatkichlari har bir akkauntning oxirgi postlari bo&apos;yicha platformadan olinadi va 30 daqiqada yangilanadi. Telegram bot ko&apos;rishlar sonini bermaydi.
        </p>
      </div>
    </>
  );
}

function NetworkTile({ network, totals: t, onOpen }: { network: StatsNetwork; totals: NetworkStats["totals"][StatsNetwork]; onOpen: () => void }) {
  if (t.accounts === 0) {
    return (
      <div className="panel flex flex-col gap-4 rounded-3xl p-5">
        <div className="flex items-center gap-3">
          <ChannelMark channel={network} />
          <div>
            <p className="font-semibold text-white">{NETWORK_NAME[network]}</p>
            <p className="text-xs text-muted">Ulanmagan</p>
          </div>
        </div>
        <a href={`/channels#net-${network}`} className="btn btn-sm btn-ghost mt-auto self-start">
          Ulash
        </a>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="panel group flex flex-col gap-4 rounded-3xl p-5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime"
    >
      <div className="flex items-center gap-3">
        <ChannelMark channel={network} />
        <div className="min-w-0">
          <p className="font-semibold text-white">{NETWORK_NAME[network]}</p>
          <p className="text-xs text-muted">{t.accounts} ta akkaunt</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
        <Metric label="Postlar" value={fmt(t.published)} big />
        <Metric label="Ko'rishlar" value={fmt(t.metrics?.views)} big />
        <Metric label="Reaksiya" value={fmt(engagement(t.metrics as Metrics | null))} />
        <Metric label="Kelgan" value={fmt(t.inbound)} />
      </dl>
      <span className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-muted transition-colors group-hover:text-lime">
        Batafsil
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3l5 5-5 5" />
        </svg>
      </span>
    </button>
  );
}

function Metric({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className={`mt-0.5 tabular-nums ${big ? "display text-xl text-white" : "font-semibold text-cloud"}`}>{value}</dd>
    </div>
  );
}

export function AccountRow({ a, onOpen }: { a: AccountStats; onOpen?: () => void }) {
  const m = a.metrics;
  const name = (
    <span className="flex min-w-0 items-center gap-2.5">
      <ChannelMark channel={a.network} size="sm" />
      <span className="min-w-0">
        <span className={`block truncate font-medium text-white ${onOpen ? "group-hover:text-lime" : ""}`}>{a.label}</span>
        {a.note && <span className="block truncate text-xs text-muted">{a.note}</span>}
      </span>
    </span>
  );
  return (
    <tr>
      <td className="max-w-[280px] py-3 pr-4">
        {onOpen ? (
          <button type="button" onClick={onOpen} className="group w-full text-left focus-visible:outline-2 focus-visible:outline-lime" title="Batafsil">
            {name}
          </button>
        ) : (
          name
        )}
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-white">{fmt(a.published)}</td>
      <td className={`px-3 py-3 text-right tabular-nums ${a.failed ? "text-error" : "text-muted"}`}>{fmt(a.failed)}</td>
      <td className="px-3 py-3 text-right tabular-nums text-muted">{fmt(m?.views)}</td>
      <td className="px-3 py-3 text-right tabular-nums text-muted">{fmt(m?.likes)}</td>
      <td className="px-3 py-3 text-right tabular-nums text-muted">{fmt(m?.comments)}</td>
      <td className="px-3 py-3 text-right tabular-nums text-muted">{fmt(m?.shares)}</td>
      <td className="px-3 py-3 text-right tabular-nums text-muted">
        {fmt(a.inbound)} / {fmt(a.replies)}
      </td>
    </tr>
  );
}
