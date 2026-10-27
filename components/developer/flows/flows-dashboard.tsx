"use client";

/**
 * ETAP 6/7 — Flow Builder, the developer screen. One /meta call feeds every
 * tab (accounts with their JavobAI mode, tags, CRM stages, intents, limits,
 * what the caller may do). The URL carries the state so a link opens the
 * right place: ?tab=list|templates|ai, or ?flow=<id>&view=builder|audit|test|
 * versions|runs|publish.
 */

import { ServerOffNotice } from "@/components/developer/server-off";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DevBadge, Pill, secondaryButton } from "@/components/developer/ui";
import AiCreate from "./ai-create";
import FlowEditor, { EDITOR_TABS, type EditorTab } from "./flow-editor";
import FlowsList from "./flows-list";
import { FLOWS_API, requestJson, type FlowsMeta } from "./shared";
import TemplatesGallery from "./templates-gallery";

const TABS = [
  ["list", "Oqimlar"],
  ["templates", "Shablonlar"],
  ["ai", "AI bilan yaratish (Beta)"],
] as const;
type DashTab = (typeof TABS)[number][0];

export default function FlowsDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: DashTab = TABS.some(([key]) => key === tabParam) ? (tabParam as DashTab) : "list";
  const flowId = searchParams.get("flow");
  const viewParam = searchParams.get("view");
  const view: EditorTab = EDITOR_TABS.some(([key]) => key === viewParam) ? (viewParam as EditorTab) : "builder";

  const [meta, setMeta] = useState<FlowsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const res = await requestJson<FlowsMeta>(`${FLOWS_API}/meta`);
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

  const go = useCallback(
    (next: { tab?: DashTab; flow?: string | null; view?: EditorTab }) => {
      const params = new URLSearchParams();
      if (next.flow) {
        params.set("flow", next.flow);
        params.set("view", next.view ?? "builder");
      } else params.set("tab", next.tab ?? "list");
      router.replace(`/developer/flows?${params.toString()}`, { scroll: false });
    },
    [router]
  );

  const canWrite = meta?.me.canWrite ?? false;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Flow Builder</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Trigger → xabar → tugma → shart → lead. Oddiy rejimda bloklar ro&apos;yxati, kengaytirilganda kanvas; AI qoralama tuzadi, lekin tasdiqsiz ishga tushmaydi.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {meta && <Pill tone={canWrite ? "success" : "muted"}>{canWrite ? "Tahrirlash mumkin" : "Faqat ko'rish"}</Pill>}
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
        <ServerOffNotice
          what="Flow'lar o'chirilgan: yangi ishga tushishlar boshlanmaydi."
          ops={<><code>FLOWS_DISABLED</code> ni olib tashlab, web va worker&apos;ni qayta ishga tushiring.</>}
        />
      )}

      {!meta ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : flowId ? (
        <FlowEditor key={flowId} flowId={flowId} meta={meta} canWrite={canWrite} tab={view} onTab={(next) => go({ flow: flowId, view: next })} onBack={() => go({ tab: "list" })} />
      ) : (
        <>
          <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => go({ tab: key })}
                className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "list" ? (
            <FlowsList meta={meta} canWrite={canWrite} onOpen={(id) => go({ flow: id })} onTemplates={() => go({ tab: "templates" })} onAi={() => go({ tab: "ai" })} />
          ) : tab === "templates" ? (
            <TemplatesGallery meta={meta} canWrite={canWrite} onOpen={(id) => go({ flow: id })} />
          ) : (
            <AiCreate meta={meta} canWrite={canWrite} onOpen={(id) => go({ flow: id, view: "test" })} />
          )}
        </>
      )}
    </div>
  );
}
