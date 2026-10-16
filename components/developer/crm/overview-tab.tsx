"use client";

/**
 * Umumiy: counts by status / temperature, open deals per stage, unassigned,
 * today's inbound, and the one-off backfill of the four stores into CRM.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { primaryButton, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import type { Navigate } from "./crm-dashboard";
import { CRM_API, requestJson, TEMPERATURE_TEXT, type Meta, type Temperature } from "./shared";

interface Overview {
  contacts: number;
  byStatus: { status: string; label: string; count: number }[];
  byTemperature: { temperature: string; count: number }[];
  withAiState: number;
  withPhone: number;
  optedOut: number;
  unassigned: number;
  inboundToday: number;
  windowOpen: number;
  openDeals: { stageId: string; name: string; color: string | null; kind: string; count: number }[];
  wonDeals: number;
  lostDeals: number;
  broadcasts: { running: number; scheduled: number };
  tags: number;
  segments: number;
  rules: number;
}

function Stat({ label, value, tone, onClick }: { label: string; value: number | string; tone?: string; onClick?: () => void }) {
  const body = (
    <>
      <p className="label-mono truncate text-[10px] font-semibold text-muted">{label}</p>
      <p className={`mt-1 truncate text-xl font-bold ${tone ?? "text-foreground"}`}>{value}</p>
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="panel min-w-0 rounded-xl px-4 py-3 text-left hover:border-accent/40">
        {body}
      </button>
    );
  }
  return <div className="panel min-w-0 rounded-xl px-4 py-3">{body}</div>;
}

export default function OverviewTab({ meta, navigate }: { meta: Meta; navigate: Navigate }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backfill, setBackfill] = useState<{ busy: boolean; queued: boolean; error: string | null }>({ busy: false, queued: false, error: null });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<Overview>(`${CRM_API}/overview`);
    if (mine !== seq.current) return;
    if (res.ok) setData(res.data);
    else setError(res.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  async function runBackfill() {
    setBackfill({ busy: true, queued: false, error: null });
    const res = await requestJson<{ queued: true }>(`${CRM_API}/backfill`, { method: "POST" });
    if (res.ok) setBackfill({ busy: false, queued: true, error: null });
    else setBackfill({ busy: false, queued: false, error: res.error });
    void load();
  }

  const total = data?.contacts ?? 0;
  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%");

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span>{error}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      {!data ? (
        !error && <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Kontaktlar" value={data.contacts} onClick={() => navigate({ tab: "contacts" })} />
            <Stat label="Bugun yozganlar" value={data.inboundToday} tone={data.inboundToday ? "text-success" : undefined} />
            <Stat label="24 soatlik oyna ochiq" value={data.windowOpen} />
            <Stat label="Operator biriktirilmagan" value={data.unassigned} tone={data.unassigned ? "text-warning" : undefined} />
            <Stat label="Telefon bor" value={`${data.withPhone} · ${pct(data.withPhone)}`} />
            <Stat label="JavobAI holati bor" value={`${data.withAiState} · ${pct(data.withAiState)}`} />
            <Stat label="Obunadan chiqqan" value={data.optedOut} tone={data.optedOut ? "text-warning" : undefined} />
            <Stat
              label="Broadcast"
              value={`${data.broadcasts.running} yuborilmoqda · ${data.broadcasts.scheduled} rejada`}
              onClick={() => navigate({ tab: "broadcast" })}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="panel space-y-3 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-foreground">Holat bo&apos;yicha</h2>
              <ul className="space-y-1.5">
                {data.byStatus.map((row) => (
                  <li key={row.status} className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted">{row.label}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded-full bg-border">
                      <span className="block h-full rounded-full bg-accent" style={{ width: total ? `${(row.count / total) * 100}%` : 0 }} />
                    </span>
                    <span className="w-12 text-right tabular-nums text-foreground">{row.count}</span>
                  </li>
                ))}
              </ul>
              <h2 className="pt-2 text-sm font-semibold text-foreground">Harorat (JavobAI)</h2>
              <ul className="flex flex-wrap gap-2">
                {data.byTemperature.map((row) => {
                  const t = TEMPERATURE_TEXT[row.temperature as Temperature];
                  return (
                    <li key={row.temperature} className="rounded-lg border border-border px-3 py-1.5 text-sm">
                      <span className="mr-1">{t?.emoji}</span>
                      <span className="text-muted">{t?.label ?? row.temperature}</span>
                      <span className="ml-2 font-semibold text-foreground">{row.count}</span>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="panel space-y-3 rounded-xl p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">Ochiq bitimlar (bosqich bo&apos;yicha)</h2>
                <button type="button" className={secondaryButton} onClick={() => navigate({ tab: "pipeline" })}>
                  Pipeline
                </button>
              </div>
              {data.openDeals.length === 0 ? (
                <p className="text-sm text-muted">Bosqichlar hali yo&apos;q.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.openDeals.map((stage) => (
                    <li key={stage.stageId} className="flex items-center gap-3 text-sm">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: stage.color ?? "#888" }} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-foreground">{stage.name}</span>
                      <span className="tabular-nums text-foreground">{stage.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted">
                Yutildi: <b className="text-success">{data.wonDeals}</b> · Yo&apos;qotildi: <b className="text-error">{data.lostDeals}</b> · Taglar:{" "}
                {data.tags} · Segmentlar: {data.segments} · Faol qoidalar: {data.rules}
              </p>
            </section>
          </div>
        </>
      )}

      <section className="panel space-y-3 rounded-xl p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Backfill — mavjud ma&apos;lumotlarni CRM&apos;ga yig&apos;ish</h2>
          <p className="mt-1 text-xs text-muted">
            InstagramContact, Conversation, Lead va DmLog jadvallaridagi har bir odam uchun bitta CrmContact yaratadi (akkaunt + Instagram id
            bo&apos;yicha), leadlarga bitim ochadi. Fon vazifasi sifatida ishlaydi (500 tadan); tarixiy yozuvlar uchun Telegram xabarlari va
            avtomatik biriktirish ishlamaydi. Qayta ishga tushirish xavfsiz: mavjud yozuvlar yangilanadi, takror yaratilmaydi.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {meta.me.canManage ? (
            <ConfirmButton
              label={backfill.busy ? "Ishlamoqda…" : "Backfill'ni ishga tushirish"}
              question="Barcha jadvallar skanerlanadi. Davom etilsinmi?"
              confirmLabel="Ha, boshlash"
              busy={backfill.busy}
              onConfirm={() => void runBackfill()}
            />
          ) : (
            <button type="button" className={primaryButton} disabled>
              Faqat menejer / admin
            </button>
          )}
          {backfill.queued && (
            <span className="text-xs text-muted">
              Navbatga qo&apos;yildi — worker bir necha daqiqada tugatadi. Natijani ko&apos;rish uchun &quot;Umumiy&quot; sonlarini yangilang.
            </span>
          )}
        </div>
        {backfill.error && <Notice tone="error">{backfill.error}</Notice>}
      </section>
    </div>
  );
}
