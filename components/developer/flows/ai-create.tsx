"use client";

/**
 * "AI bilan yaratish": a request in Uzbek or Russian + account + optional
 * trigger type -> the model drafts a graph -> preview (blocks + phone) with
 * the audit and policy verdicts -> "Qoralama sifatida saqlash". Nothing is
 * saved or sent until the merchant saves; an AI version never runs without
 * a test and an approval.
 */

import { useRef, useState } from "react";
import { CharCount, Notice } from "@/components/developer/comments/parts";
import { inputClass, Pill, primaryButton } from "@/components/developer/ui";
import AuditPanel from "./audit-panel";
import { BlockOutline, PhonePreview } from "./previews";
import { FLOWS_API, jsonInit, requestJson, TRIGGER_OPTIONS, type FlowsMeta, type GeneratedFlow, type TriggerType } from "./shared";

const EXAMPLES = [
  "Komment ostiga 'narx' yozgan odamga narxni yuborish, keyin telefon raqamini so'rash va lead sifatida Telegram'ga jo'natish.",
  "Story'da meni belgilagan odamga rahmat aytib, chegirma taklif qilish; qiziqsa telefon so'rash.",
  "Direct'ga 'manzil' yozganlarga manzilni yuborish, 1 soatdan keyin buyurtma berishni eslatish.",
];

export default function AiCreate({ meta, canWrite, onOpen }: { meta: FlowsMeta; canWrite: boolean; onOpen: (flowId: string) => void }) {
  const [request, setRequest] = useState("");
  const [accountId, setAccountId] = useState(meta.accounts[0]?.id ?? "");
  const [trigger, setTrigger] = useState<"" | TriggerType>("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(GeneratedFlow & { request: string; accountId: string }) | null>(null);
  const [name, setName] = useState("");
  const seq = useRef(0);

  async function generate() {
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson<GeneratedFlow>(`${FLOWS_API}/ai/generate`, jsonInit("POST", { request, accountId, triggerType: trigger || undefined }));
      if (mine !== seq.current) return;
      if (res.ok) {
        setResult({ ...res.data, request, accountId });
        setName(res.data.name);
      } else setError(res.error);
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }

  async function saveDraft() {
    if (!result) return;
    setSaving(true);
    setError(null);
    try {
      const res = await requestJson<{ flow: { id: string } }>(FLOWS_API, jsonInit("POST", { name: name.trim() || result.name, instagramAccountId: result.accountId, graph: result.graph, prompt: result.request, mode: "SIMPLE" }));
      if (res.ok) onOpen(res.data.flow.id);
      else setError(res.error);
    } finally {
      setSaving(false);
    }
  }

  const blocked = result?.policy.verdict === "BLOCKED";

  return (
    <div className="space-y-6">
      <Notice tone="warning">
        <strong>AI yaratgan versiya tasdiqsiz ishga tushmaydi.</strong> Qoralamani saqlagach uni Test bo&apos;limida sinab, o&apos;qib chiqib tasdiqlaysiz — shundan keyingina ishga tushirish mumkin. AI narx yoki manzilni o&apos;ylab topmaydi: faqat bilimlar bazasidagi ma&apos;lumotdan foydalanadi.
      </Notice>

      <section aria-label="So'rov" className="panel space-y-4 rounded-xl p-4 sm:p-5">
        <div className="flex flex-col gap-1.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="ai-request" className="label-mono text-[11px] font-semibold text-muted">
              Oqim nima qilishi kerak?
            </label>
            <CharCount value={request} max={2000} />
          </div>
          <textarea
            id="ai-request"
            className={`${inputClass} resize-y`}
            rows={5}
            maxLength={2000}
            value={request}
            placeholder="Masalan: komment ostiga 'narx' yozganlarga narxni yuborib, telefon raqamini so'rang…"
            onChange={(e) => setRequest(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Namunalar">
            {EXAMPLES.map((example, i) => (
              <button key={i} type="button" className="rounded-full border border-border px-2.5 py-1 text-left text-[11px] text-muted hover:border-accent/40 hover:text-foreground" onClick={() => setRequest(example)}>
                Namuna {i + 1}
              </button>
            ))}
          </div>
        </div>
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
            <span className="label-mono text-[11px] font-semibold text-muted">Trigger turi</span>
            <select className={inputClass} value={trigger} onChange={(e) => setTrigger(e.target.value as "" | TriggerType)}>
              <option value="">AI o&apos;zi tanlasin</option>
              {TRIGGER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={primaryButton} disabled={busy || !canWrite || request.trim().length < 8 || !accountId} onClick={() => void generate()}>
            {busy ? "AI yozmoqda… (30 soniyagacha)" : result ? "Qayta yaratish" : "Yaratish"}
          </button>
          {!canWrite && <span className="text-xs text-muted">MANAGER roli kerak.</span>}
          {meta.accounts.length === 0 && <span className="text-xs text-warning">Instagram akkaunt ulanmagan.</span>}
          <span className="text-xs text-muted">Soatiga 10 tagacha so&apos;rov.</span>
        </div>
      </section>

      {result && (
        <section aria-label="Natija" className="space-y-5">
          <div className="panel space-y-3 rounded-xl p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">AI qoralamasi</h2>
              <Pill tone={result.policy.verdict === "PASS" ? "success" : result.policy.verdict === "WARNING" ? "warning" : "error"}>{result.policy.verdict}</Pill>
              <Pill tone={result.audit.errors.length ? "error" : "success"}>{result.audit.errors.length} xato</Pill>
              <span className="label-mono text-[10px] text-muted">{result.model}{result.repaired ? " · 1 marta tuzatilgan" : ""}</span>
            </div>
            {result.summary && <p className="text-sm text-muted">{result.summary}</p>}
            {result.warnings.length > 0 && (
              <Notice tone="warning">
                <ul className="list-disc space-y-0.5 pl-4">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Notice>
            )}
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
              <BlockOutline graph={result.graph} meta={meta} />
              <PhonePreview graph={result.graph} />
            </div>
          </div>

          <div className="panel space-y-3 rounded-xl p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-foreground">Tekshiruv natijasi</h2>
            <AuditPanel audit={result.audit} policy={result.policy} onFocus={() => {}} />
          </div>

          <div className="panel space-y-3 rounded-xl p-4 sm:p-5">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="label-mono text-[11px] font-semibold text-muted">Oqim nomi</span>
              <input className={inputClass} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </label>
            {blocked && <p className="text-xs text-warning">Policy BLOCKED: qoralamani saqlash mumkin, lekin tuzatmasdan ishga tushirib bo&apos;lmaydi.</p>}
            <button type="button" className={primaryButton} disabled={saving || !canWrite} onClick={() => void saveDraft()}>
              {saving ? "Saqlanmoqda…" : "Qoralama sifatida saqlash"}
            </button>
            <p className="text-xs text-muted">Saqlangach Test va Nashr bo&apos;limlari ochiladi. Hozircha hech narsa ishga tushmaydi.</p>
          </div>
        </section>
      )}
    </div>
  );
}
