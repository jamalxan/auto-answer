"use client";

/**
 * Versions: every saved version with its state, source, audit / policy
 * summary and test / approval / publish stamps; node-level diff between two
 * versions; restore an older version as the new draft.
 */

import { useEffect, useRef, useState } from "react";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { EmptyState, formatDateTime, inputClass, Pill, secondaryButton } from "@/components/developer/ui";
import { FLOWS_API, jsonInit, requestJson, shortHash, SOURCE_TEXT, valueText, type DiffView, type VersionSummary } from "./shared";
import { VerdictPill } from "./previews";

const STATE_TEXT: Record<VersionSummary["state"], { label: string; tone: "success" | "warning" | "muted" }> = {
  DRAFT: { label: "Qoralama", tone: "warning" },
  PUBLISHED: { label: "Ishlayapti", tone: "success" },
  RETIRED: { label: "To'xtatilgan", tone: "muted" },
  OLD: { label: "Eski", tone: "muted" },
};

const TYPE_FIELD: Record<string, string> = { text: "Matn", keywords: "Kalit so'zlar", button: "Tugma", buttons: "Tugmalar", minutes: "Daqiqa", branches: "Tarmoqlar", url: "Manzil", tagSlugs: "Teglar" };

function DiffPanel({ diff }: { diff: DiffView }) {
  const d = diff.diff;
  if (d.identical) return <p className="text-sm text-muted">v{diff.a.version} va v{diff.b.version} bir xil (faqat joylashuv farq qilishi mumkin).</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground">
        v{diff.a.version} → v{diff.b.version}: <strong>{d.added.length}</strong> qo&apos;shilgan, <strong>{d.removed.length}</strong> o&apos;chirilgan, <strong>{d.changed.length}</strong> o&apos;zgargan blok
      </p>
      {d.added.length > 0 && (
        <section aria-label="Qo'shilgan bloklar" className="space-y-1">
          <h4 className="text-xs font-semibold text-success">Qo&apos;shilgan</h4>
          <ul className="space-y-1">
            {d.added.map((n) => (
              <li key={n.id} className="rounded-lg border border-success/30 px-3 py-1.5 text-sm">
                + {n.id} <span className="text-muted">({n.type})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {d.removed.length > 0 && (
        <section aria-label="O'chirilgan bloklar" className="space-y-1">
          <h4 className="text-xs font-semibold text-error">O&apos;chirilgan</h4>
          <ul className="space-y-1">
            {d.removed.map((n) => (
              <li key={n.id} className="rounded-lg border border-error/30 px-3 py-1.5 text-sm">
                − {n.id} <span className="text-muted">({n.type})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {d.changed.length > 0 && (
        <section aria-label="O'zgargan bloklar" className="space-y-2">
          <h4 className="text-xs font-semibold text-warning">O&apos;zgargan</h4>
          {d.changed.map((n) => (
            <div key={n.id} className="rounded-lg border border-warning/30 px-3 py-2">
              <p className="text-sm font-semibold text-foreground">
                {n.id} <span className="font-normal text-muted">({n.type})</span>
              </p>
              <ul className="mt-1 space-y-1.5">
                {n.fields.map((f) => (
                  <li key={f.field} className="grid gap-1 text-xs sm:grid-cols-[7rem_1fr_1fr]">
                    <span className="label-mono text-[10px] text-muted">{TYPE_FIELD[f.field] ?? f.field}</span>
                    <span className="break-words rounded bg-error/10 px-1.5 py-0.5 text-foreground">− {valueText(f.before)}</span>
                    <span className="break-words rounded bg-success/10 px-1.5 py-0.5 text-foreground">+ {valueText(f.after)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {(d.edgesAdded.length > 0 || d.edgesRemoved.length > 0) && (
        <section aria-label="Bog'lanishlar" className="space-y-1">
          <h4 className="text-xs font-semibold text-muted">Bog&apos;lanishlar</h4>
          <ul className="space-y-0.5 text-xs">
            {d.edgesAdded.map((e, i) => (
              <li key={`a${i}`} className="text-success">
                + {e.from} ({e.handle}) → {e.to}
              </li>
            ))}
            {d.edgesRemoved.map((e, i) => (
              <li key={`r${i}`} className="text-error">
                − {e.from} ({e.handle}) → {e.to}
              </li>
            ))}
          </ul>
        </section>
      )}
      {(d.variablesAdded.length > 0 || d.variablesRemoved.length > 0) && (
        <p className="text-xs text-muted">
          O&apos;zgaruvchilar: {d.variablesAdded.map((v) => `+${v}`).join(" ")} {d.variablesRemoved.map((v) => `−${v}`).join(" ")}
        </p>
      )}
    </div>
  );
}

export default function VersionsTab({ flowId, refreshKey, dirty, onRestored }: { flowId: string; refreshKey: number; dirty: boolean; onRestored: () => void }) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [diff, setDiff] = useState<DiffView | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState<string | null>(null);
  const listSeq = useRef(0);
  const diffSeq = useRef(0);

  useEffect(() => {
    const mine = ++listSeq.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on open / after a save
    setLoading(true);
    void (async () => {
      try {
        const res = await requestJson<{ versions: VersionSummary[] }>(`${FLOWS_API}/${flowId}/versions`);
        if (mine !== listSeq.current) return;
        if (res.ok) {
          setVersions(res.data.versions);
          setError(null);
        } else setError(res.error);
      } finally {
        if (mine === listSeq.current) setLoading(false);
      }
    })();
    const counter = listSeq;
    return () => {
      counter.current++;
    };
  }, [flowId, refreshKey]);

  async function compare(left: string, right: string) {
    if (!left || !right) return;
    const mine = ++diffSeq.current;
    setDiffBusy(true);
    setError(null);
    try {
      const res = await requestJson<DiffView>(`${FLOWS_API}/${flowId}/diff?a=${encodeURIComponent(left)}&b=${encodeURIComponent(right)}`);
      if (mine !== diffSeq.current) return;
      if (res.ok) setDiff(res.data);
      else setError(res.error);
    } finally {
      if (mine === diffSeq.current) setDiffBusy(false);
    }
  }

  async function restore(versionId: string) {
    setRestoreBusy(versionId);
    setError(null);
    try {
      const res = await requestJson<unknown>(`${FLOWS_API}/${flowId}/versions/${versionId}/restore`, jsonInit("POST", {}));
      if (res.ok) onRestored();
      else setError(res.error);
    } finally {
      setRestoreBusy(null);
    }
  }

  if (!versions) return <p className="py-8 text-center text-sm text-muted">{loading ? "Yuklanmoqda…" : (error ?? "")}</p>;
  if (versions.length === 0) return <EmptyState title="Versiyalar yo'q" />;

  return (
    <div className="space-y-6">
      {error && <Notice tone="error">{error}</Notice>}
      <ul className="space-y-2">
        {versions.map((v, i) => (
          <li key={v.id} className="panel rounded-xl p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">v{v.version}</span>
              <Pill tone={STATE_TEXT[v.state].tone}>{STATE_TEXT[v.state].label}</Pill>
              <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[11px] text-muted">{SOURCE_TEXT[v.source]}</span>
              <span className="label-mono text-[10px] text-muted">{shortHash(v.hash)}</span>
              <VerdictPill verdict={v.policyVerdict} />
              {v.auditCounts && (
                <span className="text-xs text-muted">
                  {v.auditCounts.errors} xato · {v.auditCounts.warnings} ogohlantirish
                </span>
              )}
              <span className="ml-auto text-xs text-muted">{formatDateTime(v.createdAt)}</span>
            </div>
            {v.changeNote && <p className="mt-1 break-words text-sm text-muted">{v.changeNote}</p>}
            <p className="mt-1 text-xs text-muted">
              {v.testedAt ? `Sinalgan ${formatDateTime(v.testedAt)}` : "Sinalmagan"} · {v.approvedAt ? `Tasdiqlangan ${formatDateTime(v.approvedAt)}` : "Tasdiqlanmagan"}
              {v.publishedAt ? ` · Ishga tushirilgan ${formatDateTime(v.publishedAt)}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {i < versions.length - 1 && (
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => {
                    setA(versions[i + 1].id);
                    setB(v.id);
                    void compare(versions[i + 1].id, v.id);
                  }}
                >
                  Oldingisi bilan solishtirish
                </button>
              )}
              {v.state !== "DRAFT" && (
                <ConfirmButton
                  label="Qoralama sifatida tiklash"
                  question={dirty ? "Saqlanmagan o'zgarishlar va joriy qoralama almashtiriladi. Davom etasizmi?" : "Joriy qoralama shu versiya bilan almashtiriladi. Davom etasizmi?"}
                  confirmLabel="Tiklash"
                  busy={restoreBusy === v.id}
                  disabled={restoreBusy !== null}
                  onConfirm={() => void restore(v.id)}
                />
              )}
            </div>
          </li>
        ))}
      </ul>

      {versions.length > 1 && (
        <section aria-label="Solishtirish" className="panel space-y-3 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-foreground">Ikki versiyani solishtirish</h3>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="label-mono text-[11px] font-semibold text-muted">Eski</span>
              <select className={inputClass} value={a} onChange={(e) => setA(e.target.value)}>
                <option value="">Tanlang…</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="label-mono text-[11px] font-semibold text-muted">Yangi</span>
              <select className={inputClass} value={b} onChange={(e) => setB(e.target.value)}>
                <option value="">Tanlang…</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className={secondaryButton} disabled={!a || !b || diffBusy} onClick={() => void compare(a, b)}>
              {diffBusy ? "Solishtirilmoqda…" : "Solishtirish"}
            </button>
          </div>
          {diff && <DiffPanel diff={diff} />}
        </section>
      )}
    </div>
  );
}
