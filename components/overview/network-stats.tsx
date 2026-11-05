"use client";

/**
 * Umumiy ko'rinish → "Barcha tarmoqlar": one view of every connected network.
 * Per-network tiles (posts out, engagement), then a table with one row per
 * account. Numbers we cannot get (Telegram views, a network without the
 * statistics permission) show as "—" with the reason, never as a zero.
 */

import { useEffect, useState } from "react";
import { EmptyState } from "@/components/ui/page";
import { ChannelMark, NETWORK_NAME } from "@/components/channels/ui";
import type { AccountStats, Metrics, NetworkStats, StatsNetwork } from "@/lib/analytics/network-stats";
import { requestJson } from "@/lib/request-json";

const ORDER: StatsNetwork[] = ["instagram", "facebook", "threads", "youtube", "telegram"];
const RANGES = [7, 30, 90] as const;

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("uz-UZ");
}

function engagement(m: Metrics | null): number | null {
  if (!m) return null;
  const parts = [m.likes, m.comments, m.shares].filter((v): v is number => v !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

export default function NetworkStatsView() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<NetworkStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    requestJson<NetworkStats>(`/api/analytics/networks?days=${days}`).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setData(res.data);
        setError(null);
      } else setError(res.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const pick = (d: (typeof RANGES)[number]) => {
    if (d === days) return;
    setLoading(true);
    setDays(d);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Har bir ulangan tarmoq va akkaunt: chiqqan postlar, ularning natijasi va kelgan xabarlar.</p>
        <div className="flex gap-2" role="group" aria-label="Davr">
          {RANGES.map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => pick(d)} className={`chip ${days === d ? "chip-active" : ""}`}>
              {d} kun
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="panel rounded-3xl p-6 text-sm text-error">{error}</div>
      ) : !data || loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-busy="true">
          {ORDER.map((n) => (
            <div key={n} className="panel h-36 animate-pulse rounded-2xl" />
          ))}
        </div>
      ) : data.accounts.length === 0 ? (
        <div className="panel rounded-3xl p-6">
          <EmptyState title="Hali tarmoq ulanmagan" body="Kanallar bo'limida Instagram, Facebook, Threads, YouTube yoki Telegram'ni ulang — statistika shu yerda paydo bo'ladi." />
          <div className="mt-4 text-center">
            <a href="/channels" className="btn btn-sm btn-lime">
              Kanallarga o&apos;tish
            </a>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {ORDER.map((n) => {
              const t = data.totals[n];
              const off = t.accounts === 0;
              return (
                <div key={n} className={`panel flex flex-col gap-3 rounded-2xl p-4 ${off ? "opacity-55" : ""}`}>
                  <div className="flex items-center gap-2">
                    <ChannelMark channel={n} size="sm" />
                    <span className="text-sm font-semibold text-white">{NETWORK_NAME[n]}</span>
                  </div>
                  {off ? (
                    <a href="/channels" className="text-xs text-muted underline-offset-2 hover:text-white hover:underline">
                      Ulanmagan
                    </a>
                  ) : (
                    <dl className="grid grid-cols-2 gap-x-2 gap-y-2 text-xs">
                      <div>
                        <dt className="text-muted">Postlar</dt>
                        <dd className="text-lg font-bold tabular-nums text-white">{fmt(t.published)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Ko&apos;rishlar</dt>
                        <dd className="text-lg font-bold tabular-nums text-white">{fmt(t.metrics?.views)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Reaksiya</dt>
                        <dd className="font-semibold tabular-nums text-cloud">{fmt(engagement(t.metrics))}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Kelgan</dt>
                        <dd className="font-semibold tabular-nums text-cloud">{fmt(t.inbound)}</dd>
                      </div>
                    </dl>
                  )}
                </div>
              );
            })}
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
                    <AccountRow key={`${a.network}:${a.id}`} a={a} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs leading-5 text-muted">
              Instagram ko&apos;rsatkichlari Kontent intellekti yig&apos;gan postlardan; Facebook, Threads va YouTube — har bir akkauntning oxirgi postlari bo&apos;yicha platformadan olinadi (30 daqiqada yangilanadi). Telegram bot ko&apos;rishlar sonini bermaydi.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function AccountRow({ a }: { a: AccountStats }) {
  const m = a.metrics;
  return (
    <tr>
      <td className="py-3 pr-4">
        <div className="flex items-center gap-2">
          <ChannelMark channel={a.network} size="sm" />
          <div className="min-w-0">
            <p className="truncate font-medium text-white">{a.label}</p>
            {a.note && <p className="truncate text-xs text-muted">{a.note}</p>}
          </div>
        </div>
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
