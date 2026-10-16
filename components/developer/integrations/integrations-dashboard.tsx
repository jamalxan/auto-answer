"use client";

/**
 * ETAP 8 — Integrations 2.0, the developer screen. One /meta call (catalogue,
 * limits, accounts, CRM stages, the caller's rights) feeds every tab; tabs
 * live in the URL (?tab=connectors|events|deliveries|docs). The connector
 * list is loaded here so the Deliveries tab can filter by it and the
 * Connectors tab can refresh it after every change.
 */

import { ServerOffNotice } from "@/components/developer/server-off";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { DevBadge, Pill, secondaryButton } from "@/components/developer/ui";
import ConnectorsTab from "./connectors-tab";
import DeliveriesTab from "./deliveries-tab";
import DocsTab from "./docs-tab";
import EventsTab from "./events-tab";
import { INTEGRATIONS_API, requestJson, type ListResponse, type Meta } from "./shared";

const TABS = [
  ["connectors", "Ulanishlar"],
  ["events", "Hodisalar"],
  ["deliveries", "Yetkazishlar"],
  ["docs", "Qo'llanma"],
] as const;
export type IntegrationsTab = (typeof TABS)[number][0];

export default function IntegrationsDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: IntegrationsTab = TABS.some(([key]) => key === tabParam) ? (tabParam as IntegrationsTab) : "connectors";
  const integrationParam = searchParams.get("integration");

  const [meta, setMeta] = useState<Meta | null>(null);
  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const [metaRes, listRes] = await Promise.all([
        requestJson<Meta>(`${INTEGRATIONS_API}/meta`),
        requestJson<ListResponse>(INTEGRATIONS_API),
      ]);
      if (mine !== seq.current) return;
      if (metaRes.ok && listRes.ok) {
        setMeta(metaRes.data);
        setList(listRes.data);
      } else {
        setFailure(!metaRes.ok ? metaRes.error : !listRes.ok ? listRes.error : "Yuklanmadi");
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  const navigate = useCallback(
    (next: { tab?: IntegrationsTab; integration?: string | null }) => {
      const params = new URLSearchParams();
      params.set("tab", next.tab ?? tab);
      const integration = next.integration === undefined ? integrationParam : next.integration;
      if (integration) params.set("integration", integration);
      router.replace(`/developer/integrations?${params.toString()}`, { scroll: false });
    },
    [router, tab, integrationParam]
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Integrations 2.0</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Webhook, Google Sheets, Make, Zapier, Telegram HOT karta va amoCRM / Bitrix24 boyitish — bitta hodisa shinasi, imzolangan va
            qayta uriniladigan yetkazish. Lead yetkazish (Telegram / amoCRM / Bitrix24) o&apos;zgarmagan.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {meta && <Pill tone={meta.me.canWrite ? "success" : "muted"}>{meta.me.canWrite ? "Tahrirlash mumkin" : "Faqat ko'rish"}</Pill>}
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </button>
        </div>
      </div>

      {failure && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
        >
          <span className="min-w-0 break-words">{failure}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      {meta && !meta.busEnabled && (
        <ServerOffNotice
          what="Hodisalar shinasi o'chiq: yangi hodisalar yaratilmaydi va hech narsa yuborilmaydi. Lead yetkazish (Telegram / amoCRM / Bitrix24) bunga bog'liq emas."
          ops={<><code>INTEGRATIONS_BUS_DISABLED=1</code> yoqilgan; olib tashlab, web va worker&apos;ni qayta ishga tushiring.</>}
        />
      )}
      {meta && !meta.me.canWrite && (
        <Notice tone="info">
          Sizda o&apos;zgartirish huquqi yo&apos;q: ro&apos;yxatlarni ko&apos;rasiz, lekin ulanish yaratish, sinash va qayta yuborish mumkin emas.
          Yetkazilgan ma&apos;lumot (payload) faqat menejer va undan yuqori rolga ko&apos;rinadi.
        </Notice>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => navigate({ tab: key })}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              tab === key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {!meta || !list ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : tab === "connectors" ? (
        <ConnectorsTab meta={meta} list={list} onChanged={() => void load()} navigate={navigate} />
      ) : tab === "events" ? (
        <EventsTab meta={meta} />
      ) : tab === "deliveries" ? (
        <DeliveriesTab meta={meta} integrations={list.integrations} integrationId={integrationParam} navigate={navigate} onChanged={() => void load()} />
      ) : (
        <DocsTab meta={meta} />
      )}
    </div>
  );
}
