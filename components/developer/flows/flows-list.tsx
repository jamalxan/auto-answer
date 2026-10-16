"use client";

/**
 * Flow list: status pills, account, trigger, runs in 30 days, filters, and
 * the "Yangi flow" menu (Shablondan / Bo'sh / AI bilan).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { EmptyState, formatDateTime, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { FLOWS_API, jsonInit, requestJson, STATUS_TEXT, TRIGGER_OPTIONS, type FlowListItem, type FlowMode, type FlowsMeta, type TriggerType } from "./shared";

const STATUS_FILTERS: Array<[string, string]> = [
  ["", "Hammasi"],
  ["PUBLISHED", "Ishlayapti"],
  ["DRAFT", "Qoralama"],
  ["REVIEW", "Tasdiqlangan"],
  ["ARCHIVED", "Arxiv"],
];

function NewFlowPanel({ meta, onCreated, onTemplates, onAi, onClose }: { meta: FlowsMeta; onCreated: (id: string) => void; onTemplates: () => void; onAi: () => void; onClose: () => void }) {
  const [blank, setBlank] = useState(false);
  const [accountId, setAccountId] = useState(meta.accounts[0]?.id ?? "");
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<TriggerType>("DIRECT_MESSAGE");
  const [mode, setMode] = useState<FlowMode>("SIMPLE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson<{ flow: { id: string } }>(FLOWS_API, jsonInit("POST", { name: name.trim() || undefined, instagramAccountId: accountId, mode, triggerType: trigger }));
      if (res.ok) onCreated(res.data.flow.id);
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  const choice = "rounded-xl border border-border px-4 py-3 text-left hover:border-accent/40";
  return (
    <section aria-label="Yangi flow" className="panel space-y-4 rounded-xl p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Yangi flow qanday boshlanadi?</h2>
        <button type="button" className="text-xs text-muted hover:text-foreground" onClick={onClose}>
          Yopish
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <button type="button" className={choice} onClick={onTemplates}>
          <span className="block text-sm font-semibold text-foreground">Shablondan</span>
          <span className="block text-xs text-muted">5 ta tayyor oqim: nusxa oling va o&apos;zgartiring</span>
        </button>
        <button type="button" className={`${choice} ${blank ? "border-accent bg-accent/5" : ""}`} aria-pressed={blank} onClick={() => setBlank(true)}>
          <span className="block text-sm font-semibold text-foreground">Bo&apos;sh</span>
          <span className="block text-xs text-muted">Trigger va bitta xabardan boshlang</span>
        </button>
        <button type="button" className={choice} onClick={onAi}>
          <span className="block text-sm font-semibold text-foreground">AI bilan</span>
          <span className="block text-xs text-muted">Matn yozing — AI qoralama tuzadi (tasdiq kerak)</span>
        </button>
      </div>
      {blank && (
        <div className="space-y-3 border-t border-border pt-4">
          {meta.accounts.length === 0 ? (
            <Notice tone="warning">Instagram akkaunt ulanmagan. Avval Foundation bo&apos;limida akkaunt ulang.</Notice>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="label-mono text-[11px] font-semibold text-muted">Instagram akkaunt</span>
                <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {meta.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      @{a.username}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="label-mono text-[11px] font-semibold text-muted">Nomi</span>
                <input className={inputClass} value={name} maxLength={120} placeholder="Yangi oqim" onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="label-mono text-[11px] font-semibold text-muted">Trigger</span>
                <select className={inputClass} value={trigger} onChange={(e) => setTrigger(e.target.value as TriggerType)}>
                  {TRIGGER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="label-mono text-[11px] font-semibold text-muted">Rejim</span>
                <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as FlowMode)}>
                  <option value="SIMPLE">Oddiy (bloklar ro&apos;yxati)</option>
                  <option value="ADVANCED">Kengaytirilgan (kanvas)</option>
                </select>
              </label>
            </div>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          <button type="button" className={primaryButton} disabled={busy || !accountId} onClick={() => void create()}>
            {busy ? "Yaratilmoqda…" : "Yaratish"}
          </button>
        </div>
      )}
    </section>
  );
}

export default function FlowsList({ meta, canWrite, onOpen, onTemplates, onAi }: { meta: FlowsMeta; canWrite: boolean; onOpen: (id: string) => void; onTemplates: () => void; onAi: () => void }) {
  const [flows, setFlows] = useState<FlowListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [accountId, setAccountId] = useState("");
  const [creating, setCreating] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (status) q.set("status", status);
      if (accountId) q.set("accountId", accountId);
      const res = await requestJson<{ flows: FlowListItem[] }>(`${FLOWS_API}?${q.toString()}`);
      if (mine !== seq.current) return;
      if (res.ok) {
        setFlows(res.data.flows);
        setError(null);
      } else setError(res.error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [status, accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial / filter fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="label-mono text-[11px] font-semibold text-muted">Holat</span>
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="label-mono text-[11px] font-semibold text-muted">Akkaunt</span>
          <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">Hammasi</option>
            {meta.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
          {loading ? "Yangilanmoqda…" : "Yangilash"}
        </button>
        {canWrite && (
          <button type="button" className={`${primaryButton} ml-auto`} aria-expanded={creating} onClick={() => setCreating((v) => !v)}>
            + Yangi flow
          </button>
        )}
      </div>

      {creating && canWrite && (
        <NewFlowPanel
          meta={meta}
          onClose={() => setCreating(false)}
          onCreated={onOpen}
          onTemplates={() => {
            setCreating(false);
            onTemplates();
          }}
          onAi={() => {
            setCreating(false);
            onAi();
          }}
        />
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {!flows ? (
        <p className="py-10 text-center text-sm text-muted">{loading ? "Yuklanmoqda…" : ""}</p>
      ) : flows.length === 0 ? (
        <EmptyState title="Hali oqim yo'q" body="«Yangi flow» → Shablondan: tayyor oqimni nusxalab, 5 daqiqada ishga tushiring." />
      ) : (
        <ul className="space-y-2">
          {flows.map((f) => {
            const st = STATUS_TEXT[f.status];
            return (
              <li key={f.id}>
                <button type="button" onClick={() => onOpen(f.id)} className="panel block w-full rounded-xl p-3 text-left hover:border-accent/40 sm:p-4">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-sm font-semibold text-foreground">{f.name}</span>
                    <Pill tone={st.tone}>{st.label}</Pill>
                    {f.publishedVersion && <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-[11px] text-success">v{f.publishedVersion}</span>}
                    {f.draftVersion && f.draftVersion !== f.publishedVersion && <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[11px] text-muted">v{f.draftVersion} qoralama</span>}
                    <span className="ml-auto text-xs text-muted">{f.mode === "SIMPLE" ? "Oddiy" : "Kanvas"}</span>
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                    <span>@{f.accountUsername ?? "—"}</span>
                    <span>{meta.triggerLabels[f.triggerType] ?? f.triggerType}</span>
                    <span>30 kunda: {f.runs30d} ta ishga tushish</span>
                    {f.activeRuns > 0 && <span className="text-accent">{f.activeRuns} ta faol</span>}
                    <span>{f.lastPublishedAt ? `Oxirgi nashr: ${formatDateTime(f.lastPublishedAt)}` : `Yangilangan: ${formatDateTime(f.updatedAt)}`}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
