"use client";

/**
 * Umumiy ko'rinish → one network (Facebook, Threads, YouTube, Telegram): the
 * same depth Instagram has. Totals for the range, a per-day activity chart
 * (posts out, failures, messages in), every post with its result and link,
 * and the per-account rows. An account filter narrows all of it.
 */

import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BRAND_COLOR } from "@/components/brand-icons";
import { ChannelMark, NETWORK_NAME } from "@/components/channels/ui";
import StatCard from "@/components/stat-card";
import { EmptyState } from "@/components/ui/page";
import type { DailyPoint, DetailNetwork, DetailPost, NetworkDetail } from "@/lib/analytics/network-stats";
import { requestJson } from "@/lib/request-json";
import { AccountRow } from "./network-stats";
import { RangePicker, engagement, fmt, formatWhen, type Range } from "./format";

const GRID = "rgba(255, 255, 255, 0.08)";
const AXIS = "#a7aacb";
const SURFACE = "#13143d";
const INBOUND = "#d4ff3a";
// Amber, not red: YouTube's own colour is red and the two would merge.
const FAILED = "#ffb01f";

/** Networks whose post metrics come from the platform in a second, slower step. */
const LIVE_METRICS: DetailNetwork[] = ["facebook", "threads", "youtube"];

/** Stands in for a figure until the platform answers. */
function Pending({ wide = false }: { wide?: boolean }) {
  return <span className={`inline-block animate-pulse rounded-full bg-surface-hover align-middle ${wide ? "h-7 w-16" : "h-3.5 w-9"}`} aria-label="Yuklanmoqda" role="status" />;
}

const ABOUT: Record<DetailNetwork, string> = {
  facebook: "Sahifa postlari: reaksiyalar, izohlar va ulashishlar. Facebook post ko'rishlarini alohida ruxsatsiz bermaydi.",
  threads: "Threads postlari: ko'rishlar, layklar, javoblar (izoh) va repost + iqtibos (ulashish).",
  youtube: "YouTube videolari: ko'rishlar, layklar va izohlar.",
  telegram: "Kanal postlari va kelgan xabarlar. Telegram bot ko'rishlar sonini bermaydi.",
};

export default function NetworkDetailView({
  network,
  days,
  accountId,
  onDays,
  onAccount,
}: {
  network: DetailNetwork;
  days: Range;
  accountId: string | null;
  onDays: (d: Range) => void;
  onAccount: (id: string | null) => void;
}) {
  const query = `/api/analytics/networks/${network}?days=${days}${accountId ? `&account=${encodeURIComponent(accountId)}` : ""}`;
  const [result, setResult] = useState<{ query: string; data: NetworkDetail | null; error: string | null; metricsPending: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Two steps: the database answer paints at once (posts, chart, counts);
      // the platform metrics (one call per recent post) land on top of it.
      const fast = await requestJson<NetworkDetail>(`${query}&live=0`);
      if (cancelled) return;
      if (!fast.ok) {
        setResult({ query, data: null, error: fast.error, metricsPending: false });
        return;
      }
      const wantsLive = LIVE_METRICS.includes(network) && fast.data.posts.some((p) => p.status === "PUBLISHED");
      setResult({ query, data: fast.data, error: null, metricsPending: wantsLive });
      if (!wantsLive) return;
      const live = await requestJson<NetworkDetail>(query);
      if (cancelled) return;
      // A failed second step keeps the first answer: the table stays, the metrics show "—".
      setResult((cur) => (cur?.query === query ? { ...cur, data: live.ok ? live.data : cur.data, metricsPending: false } : cur));
    })();
    return () => {
      cancelled = true;
    };
  }, [query, network]);

  const loading = !result || result.query !== query;
  const data = result?.data ?? null;
  const metricsPending = !loading && (result?.metricsPending ?? false);
  // Keep the header steady while a new range loads.
  const accounts = data?.allAccounts ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <ChannelMark channel={network} size="lg" />
          <div className="min-w-0">
            <h2 className="display text-[1.5rem] text-white">{NETWORK_NAME[network]}</h2>
            <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted">{ABOUT[network]}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {accounts.length > 1 && (
            <select
              value={accountId ?? ""}
              onChange={(e) => onAccount(e.target.value || null)}
              className="h-10 max-w-[240px] rounded-full bg-surface pl-4 pr-3 text-sm font-semibold text-white outline-none hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-lime"
              aria-label="Akkaunt"
            >
              <option value="">Barcha akkauntlar</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
          <RangePicker value={days} onChange={onDays} />
        </div>
      </header>

      {result?.error && !loading ? (
        <div className="panel rounded-3xl p-6 text-sm text-error">{result.error}</div>
      ) : loading || !data ? (
        <div className="space-y-4" aria-busy="true" aria-label="Yuklanmoqda">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="panel h-[104px] animate-pulse rounded-2xl" />
            ))}
          </div>
          <div className="panel h-72 animate-pulse rounded-3xl" />
        </div>
      ) : data.allAccounts.length === 0 ? (
        <div className="panel rounded-3xl p-8">
          <EmptyState title={`${NETWORK_NAME[network]} ulanmagan`} body="Akkauntni Kanallar bo'limida ulang: postlar va xabarlar statistikasi shu yerda paydo bo'ladi." />
          <div className="mt-4 text-center">
            <a href={`/channels#net-${network}`} className="btn btn-sm btn-lime">
              {NETWORK_NAME[network]}ni ulash
            </a>
          </div>
        </div>
      ) : (
        <Loaded data={data} metricsPending={metricsPending} />
      )}
    </div>
  );
}

function Loaded({ data, metricsPending }: { data: NetworkDetail; metricsPending: boolean }) {
  const t = data.totals;
  const m = t.metrics;
  const telegram = data.network === "telegram";
  const metric = (v: number | null | undefined) => (metricsPending ? <Pending wide /> : fmt(v));
  const cards: Array<[string, React.ReactNode]> = telegram
    ? [
        ["Chiqqan postlar", fmt(t.published)],
        ["Chiqmay qolgan", fmt(t.failed)],
        ["Kelgan xabarlar", fmt(t.inbound)],
        ["Javob berilgan", fmt(t.replies)],
      ]
    : [
        ["Chiqqan postlar", fmt(t.published)],
        ["Ko'rishlar", metric(m?.views)],
        [data.network === "facebook" ? "Reaksiyalar" : "Layklar", metric(m?.likes)],
        ["Izohlar", metric(m?.comments)],
        ...(data.network === "youtube" ? [] : [["Ulashishlar", metric(m?.shares)] as [string, React.ReactNode]]),
        ["Kelgan / javob", `${fmt(t.inbound)} / ${fmt(t.replies)}`],
      ];
  const notes = data.accounts.filter((a) => a.note && !telegram && /ulang|ruxsat|limit|olib bo'lmadi/.test(a.note));

  return (
    <>
      {notes.length > 0 && (
        <div className="panel flex flex-col gap-3 rounded-3xl border-warning/30 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm">
            {notes.map((a) => (
              <p key={a.id} className="text-cloud">
                <span className="font-semibold text-white">{a.label}:</span> {a.note}
              </p>
            ))}
          </div>
          <a href={`/channels#net-${data.network}`} className="btn btn-sm btn-ghost shrink-0">
            Kanallarda ko&apos;rish
          </a>
        </div>
      )}

      <div className={`grid grid-cols-2 gap-3 sm:gap-4 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2 ${cards.length === 4 ? "lg:grid-cols-4" : cards.length === 5 ? "sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-3 xl:grid-cols-6"}`}>
        {cards.map(([label, value]) => (
          <StatCard key={label} label={label} value={value} />
        ))}
      </div>

      <ActivityChart daily={data.daily} network={data.network} />

      <PostsTable data={data} metricsPending={metricsPending} />

      {data.accounts.length > 1 && (
        <div className="panel rounded-3xl p-5 sm:p-6">
          <h3 className="mb-4 text-base font-bold text-white">Akkauntlar bo&apos;yicha</h3>
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
                  <th className="px-3 py-2 text-right font-semibold">Kelgan / javob</th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-midnight/40">
                {data.accounts.map((a) => (
                  <AccountRow key={a.id} a={a} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function shortDay(iso: string): string {
  const [, mm, dd] = iso.split("-");
  return `${dd}.${mm}`;
}

function ActivityChart({ daily, network }: { daily: DailyPoint[]; network: DetailNetwork }) {
  const any = daily.some((d) => d.published || d.failed || d.inbound);
  const color = BRAND_COLOR[network];
  return (
    <div className="panel rounded-3xl p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-base font-bold text-white">Faollik kunlar bo&apos;yicha</h3>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
            Chiqqan post
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: FAILED }} />
            Xato
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: INBOUND }} />
            Kelgan xabar
          </li>
        </ul>
      </div>
      {any ? (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -24 }} barGap={2}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDay} stroke={AXIS} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={18} />
              <YAxis allowDecimals={false} stroke={AXIS} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
                contentStyle={{ background: SURFACE, border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, fontSize: 12 }}
                labelStyle={{ color: "#fff", fontWeight: 600 }}
                labelFormatter={(v) => shortDay(String(v))}
              />
              <Bar dataKey="published" name="Chiqqan post" stackId="p" fill={color} maxBarSize={14} />
              <Bar dataKey="failed" name="Xato" stackId="p" fill={FAILED} radius={[3, 3, 0, 0]} maxBarSize={14} />
              <Bar dataKey="inbound" name="Kelgan xabar" fill={INBOUND} fillOpacity={0.75} radius={[3, 3, 0, 0]} maxBarSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="inset px-4 py-10 text-center text-sm text-muted">Bu davrda post ham, xabar ham bo&apos;lmagan.</p>
      )}
    </div>
  );
}

function PostsTable({ data, metricsPending }: { data: NetworkDetail; metricsPending: boolean }) {
  const telegram = data.network === "telegram";
  const many = data.allAccounts.length > 1 && !data.accountId;
  // YouTube has no share count.
  const shares = data.network !== "youtube";
  return (
    <div className="panel rounded-3xl p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-bold text-white">Postlar</h3>
        <span className="text-xs text-muted" aria-live="polite">
          {metricsPending ? "Ko'rsatkichlar platformadan yuklanmoqda…" : data.postsTotal > data.posts.length ? `oxirgi ${data.posts.length} tasi, jami ${data.postsTotal}` : null}
        </span>
      </div>
      {data.posts.length === 0 ? (
        <div className="inset px-4 py-8">
          <EmptyState title="Bu davrda post chiqmagan" body="Kontent reja bo'limida post tayyorlang va shu tarmoqni tanlang." />
          <div className="mt-4 text-center">
            <a href="/content" className="btn btn-sm btn-lime">
              Yangi post
            </a>
          </div>
        </div>
      ) : (
        <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className={`w-full text-sm ${telegram ? "min-w-[560px]" : "min-w-[760px]"}`}>
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-2 pr-4 font-semibold">Post</th>
                <th className="px-3 py-2 font-semibold">Holat</th>
                {!telegram && (
                  <>
                    <th className="px-3 py-2 text-right font-semibold">Ko&apos;rishlar</th>
                    <th className="px-3 py-2 text-right font-semibold">Layklar</th>
                    <th className="px-3 py-2 text-right font-semibold">Izohlar</th>
                    {shares && <th className="px-3 py-2 text-right font-semibold">Ulashish</th>}
                  </>
                )}
                <th className="py-2 pl-3 text-right font-semibold">Sana</th>
              </tr>
            </thead>
            <tbody className="[&>tr:nth-child(even)]:bg-midnight/40">
              {data.posts.map((p) => (
                <PostRow key={p.id} p={p} telegram={telegram} shares={shares} showAccount={many} pending={metricsPending && p.status === "PUBLISHED"} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!telegram && data.posts.some((p) => p.status === "PUBLISHED") && (
        <p className="mt-4 text-xs leading-5 text-muted">Natijalar har bir akkauntning oxirgi 10 ta posti uchun platformadan olinadi va 30 daqiqada yangilanadi. Qolganlarida &quot;—&quot;.</p>
      )}
    </div>
  );
}

function PostRow({ p, telegram, shares, showAccount, pending }: { p: DetailPost; telegram: boolean; shares: boolean; showAccount: boolean; pending: boolean }) {
  const when = p.publishedAt ?? p.failedAt;
  const title = p.caption ?? "Matnsiz post";
  const reactions = engagement(p.metrics);
  const cell = (v: number | null | undefined) => (pending ? <Pending /> : fmt(v));
  return (
    <tr className="align-top">
      <td className="max-w-[360px] py-3 pr-4">
        {p.permalink ? (
          <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="group inline-flex max-w-full items-start gap-1.5 text-white hover:text-lime">
            <span className="line-clamp-2 break-words">{title}</span>
            <svg viewBox="0 0 16 16" className="mt-1 h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3h7v7M13 3L5 11" />
            </svg>
            <span className="sr-only">(yangi oynada)</span>
          </a>
        ) : (
          <span className={`line-clamp-2 break-words ${p.caption ? "text-white" : "text-muted"}`}>{title}</span>
        )}
        {showAccount && <span className="mt-0.5 block text-xs text-muted">{p.accountLabel}</span>}
      </td>
      <td className="px-3 py-3">
        {p.status === "PUBLISHED" ? (
          <span className="inline-flex rounded-full bg-lime/15 px-2.5 py-0.5 text-xs font-semibold text-lime">Chiqdi</span>
        ) : (
          <span className="inline-flex rounded-full bg-error/15 px-2.5 py-0.5 text-xs font-semibold text-error" title={p.error ?? undefined}>
            Xato
          </span>
        )}
        {p.status === "FAILED" && p.error && <span className="mt-1 block max-w-[220px] truncate text-xs text-muted" title={p.error}>{p.error}</span>}
      </td>
      {!telegram && (
        <>
          <td className="px-3 py-3 text-right tabular-nums text-muted">{cell(p.metrics?.views)}</td>
          <td className="px-3 py-3 text-right tabular-nums text-muted">{cell(p.metrics?.likes)}</td>
          <td className="px-3 py-3 text-right tabular-nums text-muted">{cell(p.metrics?.comments)}</td>
          {shares && (
            <td className="px-3 py-3 text-right tabular-nums text-muted" title={reactions !== null ? `Jami reaksiya: ${reactions}` : undefined}>
              {cell(p.metrics?.shares)}
            </td>
          )}
        </>
      )}
      <td className="whitespace-nowrap py-3 pl-3 text-right tabular-nums text-muted">
        {when ? formatWhen(when) : "—"}
      </td>
    </tr>
  );
}
