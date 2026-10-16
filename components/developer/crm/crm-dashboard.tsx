"use client";

/**
 * ETAP 5 — CRM, the developer screen. One /meta call feeds every tab
 * (accounts, members, pipelines, tags, segments, field specs, the caller's
 * permissions); tabs live in the URL so a link opens the right one, and a
 * contact / broadcast id in the URL opens its detail.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DevBadge, Pill, secondaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import BroadcastTab from "./broadcast-tab";
import ContactsTab from "./contacts-tab";
import OverviewTab from "./overview-tab";
import PipelineTab from "./pipeline-tab";
import SegmentsTab from "./segments-tab";
import TagsTab from "./tags-tab";
import TeamTab from "./team-tab";
import { CRM_API, requestJson, type Meta } from "./shared";

const TABS = [
  ["overview", "Umumiy"],
  ["contacts", "Kontaktlar"],
  ["tags", "Taglar"],
  ["segments", "Segmentlar"],
  ["pipeline", "Pipeline"],
  ["team", "Jamoa"],
  ["broadcast", "Broadcast"],
] as const;
export type CrmTab = (typeof TABS)[number][0];

export interface Navigate {
  (next: { tab?: CrmTab; contact?: string | null; broadcast?: string | null; segment?: string | null }): void;
}

export default function CrmDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: CrmTab = TABS.some(([key]) => key === tabParam) ? (tabParam as CrmTab) : "overview";
  const contactParam = searchParams.get("contact");
  const broadcastParam = searchParams.get("broadcast");
  const segmentParam = searchParams.get("segment");

  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const res = await requestJson<Meta>(`${CRM_API}/meta`);
      if (mine !== seq.current) return;
      if (res.ok) setMeta(res.data);
      else setFailure(res.error);
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

  const navigate: Navigate = (next) => {
    const params = new URLSearchParams();
    params.set("tab", next.tab ?? tab);
    const contact = next.contact === undefined ? contactParam : next.contact;
    const broadcast = next.broadcast === undefined ? broadcastParam : next.broadcast;
    const segment = next.segment === undefined ? segmentParam : next.segment;
    if (next.tab && next.tab !== tab) {
      // Switching tabs closes the other tabs' details.
      params.delete("contact");
      params.delete("broadcast");
      params.delete("segment");
      if (next.contact) params.set("contact", next.contact);
      if (next.broadcast) params.set("broadcast", next.broadcast);
      if (next.segment) params.set("segment", next.segment);
    } else {
      if (contact) params.set("contact", contact);
      if (broadcast) params.set("broadcast", broadcast);
      if (segment) params.set("segment", segment);
    }
    router.replace(`/developer/crm?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">CRM / Lead Management</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Kontaktlar → taglar va segmentlar → pipeline → operator biriktirish → broadcast. Xabarlar ko&apos;chirilmaydi: timeline to&apos;rt
            jadvaldan jonli o&apos;qiladi.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {meta && (
            <Pill tone={meta.me.normalizedRole === "VIEWER" ? "muted" : "success"}>
              {meta.labels.role[meta.me.normalizedRole] ?? meta.me.normalizedRole}
            </Pill>
          )}
          <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </button>
        </div>
      </div>

      {failure && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span className="min-w-0 break-words">{failure}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      {meta?.disabled && (
        <Notice tone="error">
          CRM o&apos;chiq — hooklar, worker va reconciler to&apos;xtagan: yangi xabarlar CRM&apos;ga tushmaydi, broadcast
          yuborilmaydi. Yechim: serverda <code>CRM_ENABLED=1</code> qo&apos;ying (<code>CRM_DISABLED</code> bo&apos;lmasin) va web hamda
          worker&apos;ni qayta ishga tushiring.
        </Notice>
      )}

      {meta && meta.me.normalizedRole === "VIEWER" && (
        <Notice tone="info">Kuzatuvchi (VIEWER) rolidasiz: hamma narsani ko&apos;rasiz, lekin o&apos;zgartira olmaysiz.</Notice>
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

      {!meta ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : tab === "overview" ? (
        <OverviewTab meta={meta} navigate={navigate} />
      ) : tab === "contacts" ? (
        <ContactsTab meta={meta} navigate={navigate} contactId={contactParam} segmentId={segmentParam} onMetaChanged={() => void load()} />
      ) : tab === "tags" ? (
        <TagsTab meta={meta} onChanged={() => void load()} />
      ) : tab === "segments" ? (
        <SegmentsTab meta={meta} navigate={navigate} segmentId={segmentParam} onChanged={() => void load()} />
      ) : tab === "pipeline" ? (
        <PipelineTab meta={meta} navigate={navigate} onChanged={() => void load()} />
      ) : tab === "team" ? (
        <TeamTab meta={meta} onChanged={() => void load()} />
      ) : (
        <BroadcastTab meta={meta} navigate={navigate} broadcastId={broadcastParam} />
      )}
    </div>
  );
}
