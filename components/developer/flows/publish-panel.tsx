"use client";

/**
 * Publish: the checklist (structure, audit, policy, test, approval), the
 * explicit acknowledgements and the publish / unpublish / archive actions
 * with inline confirms. Rules (docs/developer/etap-6-7-flow-builder.md):
 * a BLOCKED policy or any audit error stops every publish; an AI-generated
 * version also needs a passing test and a human approval; manually built
 * flows publish directly. Publishing a new version never touches runs that
 * are already waiting: they finish on their own version.
 */

import { useState } from "react";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { formatDateTime, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { PolicyBlock } from "./audit-panel";
import { FLOWS_API, jsonInit, requestJson, type Evaluation, type FlowDetail } from "./shared";
import { VerdictPill } from "./previews";

function Check({ ok, warn, title, detail }: { ok: boolean; warn?: boolean; title: string; detail?: string }) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border px-3 py-2">
      <span
        aria-hidden="true"
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${ok ? "bg-success/15 text-success" : warn ? "bg-warning/15 text-warning" : "bg-error/15 text-error"}`}
      >
        {ok ? "✓" : warn ? "!" : "×"}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        {detail && <span className="block text-xs text-muted">{detail}</span>}
      </span>
      <span className="sr-only">{ok ? "bajarilgan" : warn ? "ogohlantirish" : "bajarilmagan"}</span>
    </li>
  );
}

export default function PublishPanel({
  detail,
  evaluation,
  dirty,
  canWrite,
  busy,
  onRunAudit,
  onChanged,
  onFocus,
  onDeleted,
}: {
  detail: FlowDetail;
  evaluation: Evaluation | null;
  dirty: boolean;
  canWrite: boolean;
  busy: boolean;
  onRunAudit: () => void;
  onChanged: () => void;
  onFocus: (nodeId: string) => void;
  onDeleted: () => void;
}) {
  const { flow, draft, published } = detail;
  const [ackWarnings, setAckWarnings] = useState(false);
  const [ackApprove, setAckApprove] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [tplName, setTplName] = useState("");

  const isAi = draft?.source === "AI";
  const ev = evaluation;
  const structuralOk = !!ev && ev.structural.length === 0;
  const auditOk = !!ev && ev.audit.errors.length === 0;
  const verdict = ev?.policy.verdict ?? null;
  const policyOk = verdict !== null && verdict !== "BLOCKED";
  const tested = !!draft?.testedAt;
  const approved = !!draft?.approvedAt;
  const needsAck = verdict === "WARNING";
  const ready = !!draft && structuralOk && auditOk && policyOk && !dirty && (!isAi || tested) && (!needsAck || ackWarnings) && (!isAi || approved || ackApprove);

  async function act(key: string, fn: () => Promise<{ ok: true } | { ok: false; error: string }>, message: string) {
    setActing(key);
    setError(null);
    setDone(null);
    try {
      const res = await fn();
      if (res.ok) {
        setDone(message);
        onChanged();
      } else setError(res.error);
    } finally {
      setActing(null);
    }
  }

  async function publish() {
    if (!draft) return;
    await act(
      "publish",
      async () => {
        if (isAi && !approved) {
          const ap = await requestJson<unknown>(`${FLOWS_API}/${flow.id}/versions/${draft.id}/approve`, jsonInit("POST", {}));
          if (!ap.ok) return ap;
        }
        const res = await requestJson<unknown>(`${FLOWS_API}/${flow.id}/versions/${draft.id}/publish`, jsonInit("POST", { acknowledgeWarnings: ackWarnings }));
        return res.ok ? { ok: true as const } : res;
      },
      "Ishga tushirildi. Yangi kelgan mijozlar shu versiyadan o'tadi; kutayotganlar o'z versiyasida tugaydi."
    );
  }

  async function approveOnly() {
    if (!draft) return;
    await act(
      "approve",
      async () => {
        const res = await requestJson<unknown>(`${FLOWS_API}/${flow.id}/versions/${draft.id}/approve`, jsonInit("POST", {}));
        return res.ok ? { ok: true as const } : res;
      },
      "Versiya tasdiqlandi."
    );
  }

  async function post(path: string, body: unknown, message: string, key: string) {
    await act(
      key,
      async () => {
        const res = await requestJson<unknown>(`${FLOWS_API}/${flow.id}/${path}`, jsonInit("POST", body));
        return res.ok ? { ok: true as const } : res;
      },
      message
    );
  }

  async function saveTemplate() {
    await act(
      "template",
      async () => {
        const res = await requestJson<unknown>(`${FLOWS_API}/templates`, jsonInit("POST", { flowId: flow.id, versionId: draft?.id ?? published?.id, name: tplName.trim() }));
        if (res.ok) setTplName("");
        return res.ok ? { ok: true as const } : res;
      },
      "Shablon sifatida saqlandi (Shablonlar bo'limida)."
    );
  }

  async function remove() {
    setActing("delete");
    setError(null);
    try {
      const res = await requestJson<unknown>(`${FLOWS_API}/${flow.id}`, { method: "DELETE" });
      if (res.ok) onDeleted();
      else setError(res.error);
    } finally {
      setActing(null);
    }
  }

  const waiting = detail.stats.activeRuns;

  return (
    <div className="space-y-6">
      {error && <Notice tone="error">{error}</Notice>}
      {done && <Notice tone="info">{done}</Notice>}

      {published && (
        <section aria-label="Ishlayotgan versiya" className="panel space-y-3 rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">Hozir ishlayotgan: v{published.version}</h3>
            <Pill tone="success">Ishlayapti</Pill>
            <span className="text-xs text-muted">{published.publishedAt ? formatDateTime(published.publishedAt) : ""}</span>
          </div>
          <p className="text-sm text-muted">
            Kutayotgan (faol) ishga tushishlar: <strong className="text-foreground">{waiting}</strong>. Yangi versiya chiqsa, ular o&apos;z versiyasida tugaydi.
          </p>
          {canWrite && flow.status === "PUBLISHED" && (
            <div className="flex flex-wrap items-center gap-2">
              <ConfirmButton
                label="To'xtatish (qoralamaga)"
                question={waiting > 0 ? `Kutayotgan ${waiting} ta ishga tushish bekor qilinadi. To'xtatilsinmi?` : "Oqim to'xtatilsinmi?"}
                confirmLabel="To'xtatish"
                danger
                busy={acting === "unpublish"}
                disabled={acting !== null}
                onConfirm={() => void post("unpublish", { to: "DRAFT" }, "Oqim to'xtatildi; kutayotgan ishga tushishlar bekor qilinadi.", "unpublish")}
              />
              <ConfirmButton
                label="Arxivlash"
                question={waiting > 0 ? `Kutayotgan ${waiting} ta ishga tushish bekor qilinadi. Arxivlansinmi?` : "Oqim arxivlansinmi?"}
                confirmLabel="Arxivlash"
                danger
                busy={acting === "archive"}
                disabled={acting !== null}
                onConfirm={() => void post("archive", {}, "Oqim arxivlandi.", "archive")}
              />
            </div>
          )}
        </section>
      )}

      {!draft ? (
        <Notice tone="info">Qoralama yo&apos;q. Tahrirlab saqlasangiz, yangi versiya ochiladi va shu yerda nashr qilish mumkin bo&apos;ladi.</Notice>
      ) : (
        <section aria-label="Nashr" className="panel space-y-4 rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">v{draft.version} ni ishga tushirish</h3>
            <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[11px] text-muted">{isAi ? "AI yaratgan" : draft.source === "TEMPLATE" ? "Shablon" : "Qo'lda"}</span>
            <VerdictPill verdict={verdict} />
          </div>

          {isAi && (
            <Notice tone="warning">
              <strong>AI yaratgan versiya tasdiqsiz ishga tushmaydi.</strong> Avval Test bo&apos;limida sinab ko&apos;ring, so&apos;ng o&apos;qib chiqib tasdiqlang. Matnni o&apos;zgartirsangiz, sinov va tasdiq bekor bo&apos;ladi.
            </Notice>
          )}

          <ul className="space-y-2" aria-label="Tekshiruvlar">
            <Check ok={!dirty} title="Barcha o'zgarishlar saqlangan" detail={dirty ? "Avval «Saqlash» ni bosing." : undefined} />
            <Check ok={structuralOk} title="Graf to'liq" detail={ev && ev.structural.length ? ev.structural[0] : !ev ? "Audit hali ishga tushmagan." : undefined} />
            <Check ok={auditOk} title="Audit: xato yo'q" detail={ev ? `${ev.audit.errors.length} xato, ${ev.audit.warnings.length} ogohlantirish` : undefined} />
            <Check ok={policyOk && !needsAck} warn={needsAck} title={`Policy: ${verdict ?? "—"}`} detail={verdict === "BLOCKED" ? "BLOCKED — nashr qilib bo'lmaydi." : needsAck ? "Ogohlantirishlar bor — pastda tasdiqlang." : undefined} />
            <Check ok={tested} warn={!isAi && !tested} title={isAi ? "Test: muvaffaqiyatli (majburiy)" : "Test: sinab ko'rilgan (tavsiya)"} detail={tested ? `Sinalgan ${formatDateTime(draft.testedAt)}` : "Test bo'limida sinab ko'ring."} />
            {isAi && <Check ok={approved} title="Inson tasdig'i" detail={approved ? `Tasdiqlangan ${formatDateTime(draft.approvedAt)}` : "Quyidagi katakchani belgilang."} />}
          </ul>

          {ev && <PolicyBlock policy={ev.policy} onFocus={onFocus} />}

          {canWrite && (
            <div className="space-y-3">
              {needsAck && (
                <label className="flex items-start gap-2 text-sm text-foreground">
                  <input type="checkbox" className="mt-1" checked={ackWarnings} onChange={(e) => setAckWarnings(e.target.checked)} />
                  Ogohlantirishlarni ko&apos;rib chiqdim va baribir ishga tushiraman
                </label>
              )}
              {isAi && !approved && (
                <label className="flex items-start gap-2 text-sm text-foreground">
                  <input type="checkbox" className="mt-1" checked={ackApprove} disabled={!tested} onChange={(e) => setAckApprove(e.target.checked)} />
                  Men bu AI yaratgan oqimni o&apos;qib chiqdim, sinab ko&apos;rdim va tasdiqlayman
                </label>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={secondaryButton} disabled={busy || acting !== null} onClick={onRunAudit}>
                  {busy ? "Tekshirilmoqda…" : "Auditni yangilash"}
                </button>
                {isAi && !approved && (
                  <button type="button" className={secondaryButton} disabled={!tested || !auditOk || !policyOk || dirty || acting !== null} onClick={() => void approveOnly()}>
                    {acting === "approve" ? "Kuting…" : "Faqat tasdiqlash"}
                  </button>
                )}
                {ready ? (
                  <ConfirmButton
                    label="Ishga tushirish"
                    question={published ? `v${draft.version} yangi mijozlar uchun ishlaydi, v${published.version} dagilar o'z versiyasida tugaydi. Davom etasizmi?` : "Oqim darhol ishlay boshlaydi. Davom etasizmi?"}
                    confirmLabel="Ishga tushirish"
                    busy={acting === "publish"}
                    disabled={acting !== null}
                    onConfirm={() => void publish()}
                  />
                ) : (
                  <button type="button" className={primaryButton} disabled>
                    Ishga tushirish
                  </button>
                )}
              </div>
              {!ready && <p className="text-xs text-muted">Ishga tushirish tugmasi yuqoridagi barcha shartlar bajarilgach yoqiladi.</p>}
            </div>
          )}
        </section>
      )}

      {canWrite && (
        <section aria-label="Boshqa amallar" className="panel space-y-4 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-foreground">Boshqa amallar</h3>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="label-mono text-[11px] font-semibold text-muted">Shablon sifatida saqlash</span>
              <input className={inputClass} value={tplName} maxLength={120} placeholder="Shablon nomi" onChange={(e) => setTplName(e.target.value)} />
            </label>
            <button type="button" className={secondaryButton} disabled={!tplName.trim() || acting !== null || dirty} onClick={() => void saveTemplate()}>
              {acting === "template" ? "Saqlanmoqda…" : "Saqlash"}
            </button>
          </div>
          {(flow.status === "DRAFT" || flow.status === "ARCHIVED") && (
            <div className="space-y-1">
              <ConfirmButton
                label="Oqimni o'chirish"
                question="Oqim va barcha versiyalari o'chiriladi. Davom etasizmi?"
                confirmLabel="O'chirish"
                danger
                busy={acting === "delete"}
                disabled={acting !== null}
                onConfirm={() => void remove()}
              />
              <p className="text-xs text-muted">Ishga tushish tarixi bo&apos;lgan oqimni o&apos;chirib bo&apos;lmaydi — arxivda qoldiring.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
