"use client";

/**
 * Template gallery: the five Uzbek-market starters plus the templates this
 * workspace saved. A card previews the blocks (outline + phone) and copies
 * the template into a new draft flow ("Nusxa olish").
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { EmptyState, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { BlockOutline, PhonePreview } from "./previews";
import { CATEGORY_TEXT, FLOWS_API, jsonInit, requestJson, type FlowsMeta, type TemplateItem } from "./shared";

function CopyForm({ template, meta, onCreated }: { template: TemplateItem; meta: FlowsMeta; onCreated: (flowId: string) => void }) {
  const [accountId, setAccountId] = useState(meta.accounts[0]?.id ?? "");
  const [name, setName] = useState(template.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copy() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson<{ flow: { id: string } }>(FLOWS_API, jsonInit("POST", { name: name.trim() || undefined, instagramAccountId: accountId, fromTemplateKey: template.key, mode: "SIMPLE" }));
      if (res.ok) onCreated(res.data.flow.id);
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  if (meta.accounts.length === 0) return <Notice tone="warning">Instagram akkaunt ulanmagan.</Notice>;
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="label-mono text-[11px] font-semibold text-muted">Akkaunt</span>
          <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {meta.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="label-mono text-[11px] font-semibold text-muted">Yangi oqim nomi</span>
          <input className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      {template.tags.length > 0 && <p className="text-xs text-muted">Yo&apos;qsa CRM&apos;da yaratiladigan teglar: {template.tags.join(", ")}</p>}
      {error && <Notice tone="error">{error}</Notice>}
      <button type="button" className={primaryButton} disabled={busy || !accountId} onClick={() => void copy()}>
        {busy ? "Nusxalanmoqda…" : "Nusxa olish"}
      </button>
    </div>
  );
}

export default function TemplatesGallery({ meta, canWrite, onOpen }: { meta: FlowsMeta; canWrite: boolean; onOpen: (flowId: string) => void }) {
  const [templates, setTemplates] = useState<TemplateItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const res = await requestJson<{ templates: TemplateItem[] }>(`${FLOWS_API}/templates`);
    if (mine !== seq.current) return;
    if (res.ok) {
      setTemplates(res.data.templates);
      setError(null);
    } else setError(res.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  async function remove(id: string) {
    setDeleting(id);
    try {
      const res = await requestJson<unknown>(`${FLOWS_API}/templates/${id}`, { method: "DELETE" });
      if (res.ok) await load();
      else setError(res.error);
    } finally {
      setDeleting(null);
    }
  }

  if (!templates) return <p className="py-10 text-center text-sm text-muted">{error ?? "Yuklanmoqda…"}</p>;
  if (templates.length === 0) return <EmptyState title="Shablonlar yo'q" />;

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid gap-4 md:grid-cols-2">
        {templates.map((t) => {
          const open = openKey === t.key;
          return (
            <article key={t.key} className="panel flex flex-col gap-3 rounded-xl p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground">{t.name}</h3>
                <Pill tone={t.builtIn ? "success" : "muted"}>{t.builtIn ? "Tayyor" : "Mening shablonim"}</Pill>
              </div>
              {t.description && <p className="text-sm text-muted">{t.description}</p>}
              <p className="flex flex-wrap gap-x-3 text-xs text-muted">
                <span>{CATEGORY_TEXT[t.category] ?? t.category}</span>
                {t.triggerType && <span>{meta.triggerLabels[t.triggerType] ?? t.triggerType}</span>}
                <span>{t.nodeCount} blok</span>
              </p>
              <div className="mt-auto flex flex-wrap items-center gap-2">
                <button type="button" className={secondaryButton} aria-expanded={open} onClick={() => setOpenKey(open ? null : t.key)}>
                  {open ? "Yopish" : "Ko'rish"}
                </button>
                {!t.builtIn && t.id && canWrite && (
                  <ConfirmButton label="O'chirish" question="Shablon o'chirilsinmi?" confirmLabel="O'chirish" danger busy={deleting === t.id} disabled={deleting !== null} onConfirm={() => void remove(t.id!)} />
                )}
              </div>
              {open && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_16rem]">
                    <BlockOutline graph={t.graph} meta={meta} />
                    <PhonePreview graph={t.graph} />
                  </div>
                  {canWrite ? <CopyForm template={t} meta={meta} onCreated={onOpen} /> : <p className="text-xs text-muted">Nusxa olish uchun MANAGER roli kerak.</p>}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
