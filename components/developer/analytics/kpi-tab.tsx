"use client";

/**
 * ETAP 10 - the KPI tab (TZ 65): live health tiles, polled every 30 s. One
 * broken source shows "yuklab bo'lmadi" on its own tile, not an error page.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { formatDateTime, Pill, secondaryButton } from "@/components/developer/ui";
import { formatMetric } from "@/lib/analytics/catalog";
import { Sparkline } from "./charts";
import { ANALYTICS_API, formatAgeMs, jsonInit, requestJson, type KpiResponse } from "./shared";

const POLL_MS = 30_000;

function Tile({ label, children, hint, failed }: { label: string; children: React.ReactNode; hint?: string; failed?: boolean }) {
  return (
    <div className="panel min-w-0 rounded-xl px-4 py-3">
      <p className="label-mono truncate text-[10px] font-semibold text-muted">{label}</p>
      <div className="mt-1 text-xl font-bold text-foreground">
        {failed ? <span className="text-sm font-medium text-error">yuklab bo&apos;lmadi</span> : children}
      </div>
      {hint && !failed && <p className="mt-0.5 truncate text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

const pctText = (rate: number | null | undefined) => (rate === null || rate === undefined ? "—" : formatMetric(rate, "pct"));

export default function KpiTab() {
  const [kpi, setKpi] = useState<KpiResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const res = await requestJson<KpiResponse>(`${ANALYTICS_API}/kpi`);
    if (mine !== seq.current) return;
    if (res.ok) {
      setKpi(res.data);
      setFailure(null);
    } else {
      setFailure(res.error);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch and polling
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const counter = seq;
    return () => {
      clearInterval(timer);
      counter.current++;
    };
  }, [load]);

  async function post(path: string, ok: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await requestJson<unknown>(`${ANALYTICS_API}/${path}`, jsonInit("POST", {}));
      setMessage(res.ok ? ok : res.error);
    } finally {
      setBusy(false);
    }
  }

  const failed = new Set(kpi?.failed ?? []);
  const isFailed = (key: string) => failed.has(key);

  return (
    <div className="space-y-6">
      {failure && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span className="min-w-0 break-words">{failure}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}
      {!kpi && !failure && <p className="text-sm text-muted">Yuklanmoqda…</p>}

      {kpi && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Tile label="INSTAGRAM ULANISHLAR" failed={isFailed("connections")} hint={kpi.connections ? `${kpi.connections.broken} tasi muammoli` : undefined}>
              {kpi.connections ? `${kpi.connections.healthy}/${kpi.connections.total}` : "—"}
            </Tile>
            <Tile label="FAOL KAMPANIYALAR" failed={isFailed("activeCampaigns")} hint={kpi.activeCampaigns ? `Comment ${kpi.activeCampaigns.automations} · Trigger ${kpi.activeCampaigns.triggers}` : undefined}>
              {kpi.activeCampaigns?.total ?? "—"}
            </Tile>
            <Tile label="XABAR / DAQIQA" failed={isFailed("messagesPerMin")} hint="Oxirgi 10 daqiqa">
              <div>
                {kpi.messagesPerMin?.perMin ?? "—"}
                {kpi.messagesPerMin && <Sparkline values={kpi.messagesPerMin.sparkline} label="Daqiqalik yuborilgan xabarlar" />}
              </div>
            </Tile>
            <Tile label="DM NAVBATI" failed={isFailed("queue")} hint={kpi.queue ? kpi.queue.dm.etaLabel : undefined}>
              {kpi.queue ? (kpi.queue.dm.queued ?? "?") : "—"}
            </Tile>
            <Tile label="XATOLAR (1 SOAT / 24 SOAT)" failed={isFailed("errors")}>
              {kpi.errors ? `${kpi.errors.last1h} / ${kpi.errors.last24h}` : "—"}
            </Tile>
            <Tile label="META XATO DARAJASI" failed={isFailed("metaErrorRate")} hint={kpi.metaErrorRate ? `Oxirgi soat: ${kpi.metaErrorRate.attempts} urinish` : undefined}>
              {pctText(kpi.metaErrorRate?.rate)}
            </Tile>
            <Tile label="AI KECHIKISH" failed={isFailed("aiLatencyMs")} hint={kpi.aiLatencyMs ? `${kpi.aiLatencyMs.calls} chaqiruv (1 soat)${kpi.aiLatencyMs.p95 ? ` · p95 ${formatMetric(kpi.aiLatencyMs.p95, "ms")}` : ""}` : undefined}>
              {!kpi.aiLatencyMs || kpi.aiLatencyMs.avg === null ? "—" : formatMetric(kpi.aiLatencyMs.avg, "ms")}
            </Tile>
            <Tile label="AI XARAJAT (BUGUN)" failed={isFailed("aiCostTodayUsd")}>
              {kpi.aiCostTodayUsd === null ? "—" : formatMetric(kpi.aiCostTodayUsd, "usd")}
            </Tile>
            <Tile label="XABAR MUVAFFAQIYATI" failed={isFailed("messageSuccessRate")} hint={kpi.messageSuccessRate ? `24 soat: ${kpi.messageSuccessRate.attempts} urinish` : undefined}>
              {pctText(kpi.messageSuccessRate?.rate)}
            </Tile>
            <Tile label="WEBHOOK KECHIKISHI" failed={isFailed("webhookDelay")} hint={kpi.webhookDelay ? `o'rtacha ${formatAgeMs(kpi.webhookDelay.avgMs)} · ${kpi.webhookDelay.samples} hodisa` : undefined}>
              {kpi.webhookDelay ? formatAgeMs(kpi.webhookDelay.maxMs) : "—"}
            </Tile>
            <Tile label="WORKER" failed={isFailed("worker")} hint={kpi.worker ? `heartbeat ${formatAgeMs(kpi.worker.ageMs)} oldin` : undefined}>
              {kpi.worker ? <Pill tone={kpi.worker.healthy ? "success" : "error"}>{kpi.worker.healthy ? "Ishlayapti" : "To'xtagan"}</Pill> : "—"}
            </Tile>
            <Tile label="BUGUN: AI SUHBAT / LID" failed={isFailed("today")} hint={kpi.today ? `Hot ${kpi.today.hot} · Sotuv ${kpi.today.conversions}` : "Rollup (~10 daq)"}>
              {kpi.today ? `${kpi.today.aiConversations} / ${kpi.today.leads}` : "—"}
            </Tile>
          </div>

          <div className="panel overflow-hidden rounded-xl">
            <div className="px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">Navbatlar</h2>
              <p className="mt-0.5 text-xs text-muted">{kpi.queueDepthsRestricted ? "Faqat platforma administratori uchun." : null} Navbat chuqurligi butun platforma bo&apos;yicha (barcha workspace&apos;lar), faqat DM navbati workspace&apos;ga xos.</p>
            </div>
            {kpi.queueDepthsRestricted ? (
              <p className="px-4 pb-4 text-sm text-muted">Platforma navbatlari barcha mijozlarga tegishli — faqat platforma administratoriga ko&apos;rinadi. Sizning DM navbatingiz yuqoridagi &quot;DM navbati&quot; kartasida.</p>
            ) : isFailed("queueDepths") || !kpi.queueDepths ? (
              <p className="px-4 pb-4 text-sm text-muted">Navbat ma&apos;lumoti hozir mavjud emas (Redis javob bermadi).</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-left text-sm">
                  <thead className="text-[11px] uppercase text-muted">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Navbat</th>
                      <th className="px-3 py-2 text-right font-semibold">Kutmoqda</th>
                      <th className="px-3 py-2 text-right font-semibold">Ishlamoqda</th>
                      <th className="px-3 py-2 text-right font-semibold">Kechiktirilgan</th>
                      <th className="px-3 py-2 text-right font-semibold">Xato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kpi.queueDepths.map((q) => (
                      <tr key={q.queue} className="border-t border-border">
                        <td className="px-4 py-2 text-foreground">{q.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{q.waiting}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{q.active}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">{q.delayed}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${q.failed > 0 ? "text-error" : "text-muted"}`}>{q.failed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel rounded-xl p-4">
            <h2 className="text-sm font-semibold text-foreground">Ogohlantirish qoidalari</h2>
            <p className="mt-0.5 text-xs text-muted">Har bir qoida 6 soatda ko&apos;pi bilan bir marta Telegram / email orqali yuboriladi.</p>
            <ul className="mt-3 divide-y divide-border">
              {kpi.alertRules.map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{rule.label}</p>
                    <p className="text-xs text-muted">{rule.threshold}</p>
                  </div>
                  <p className="text-xs text-muted">{rule.lastAlertedAt ? `Oxirgi: ${formatDateTime(rule.lastAlertedAt)}` : "Hali yuborilmagan"}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel space-y-3 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-foreground">Rollup boshqaruvi</h2>
            <p className="text-xs text-muted">Bugun va kecha har 10 daqiqada o&apos;zi yangilanadi; kechasi oxirgi 3 kun qayta hisoblanadi. Eski kunlar uchun backfill ishlating.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={secondaryButton} disabled={busy} onClick={() => void post("recompute", "Bugun qayta hisoblandi")}>
                Bugunni qayta hisoblash
              </button>
              <button type="button" className={secondaryButton} disabled={busy} onClick={() => void post("backfill?days=90", "90 kunlik backfill navbatga qo'yildi")}>
                Backfill (90 kun)
              </button>
            </div>
            {message && <Notice tone="info">{message}</Notice>}
          </div>
        </>
      )}
    </div>
  );
}
