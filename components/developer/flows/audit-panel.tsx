"use client";

/**
 * Audit panel: policy verdict (PASS / WARNING / BLOCKED) with its items,
 * then errors / warnings / suggestions of the deterministic auditor. A
 * finding with a node id focuses that block in the editor.
 */

import { Pill, secondaryButton } from "@/components/developer/ui";
import type { AuditView, Evaluation, Finding, PolicyView } from "./shared";
import { VerdictPill } from "./previews";

function FindingRow({ finding, tone, onFocus }: { finding: Finding; tone: "error" | "warning" | "muted"; onFocus: (nodeId: string) => void }) {
  const color = tone === "error" ? "border-error/30" : tone === "warning" ? "border-warning/30" : "border-border";
  return (
    <li className={`rounded-lg border ${color} px-3 py-2`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 break-words text-sm text-foreground">{finding.message}</p>
        {finding.nodeId && (
          <button type="button" className={secondaryButton} onClick={() => onFocus(finding.nodeId!)} aria-label={`${finding.nodeId} blokiga o'tish`}>
            {finding.nodeId} →
          </button>
        )}
      </div>
      {finding.fix && <p className="mt-1 text-xs text-muted">Yechim: {finding.fix}</p>}
      <p className="label-mono mt-1 text-[10px] text-muted">{finding.code}</p>
    </li>
  );
}

function Group({ title, tone, items, onFocus }: { title: string; tone: "error" | "warning" | "muted"; items: Finding[]; onFocus: (nodeId: string) => void }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {title}
        <Pill tone={tone}>{items.length}</Pill>
      </h3>
      <ul className="space-y-2">
        {items.map((f, i) => (
          <FindingRow key={`${f.code}-${f.nodeId ?? ""}-${i}`} finding={f} tone={tone} onFocus={onFocus} />
        ))}
      </ul>
    </section>
  );
}

export function PolicyBlock({ policy, onFocus }: { policy: PolicyView; onFocus: (nodeId: string) => void }) {
  return (
    <section aria-label="Policy" className="space-y-2 rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">Policy tekshiruvi</h3>
        <VerdictPill verdict={policy.verdict} />
        <span className="text-xs text-muted">
          {policy.verdict === "PASS" && "Instagram qoidalariga zid joy topilmadi."}
          {policy.verdict === "WARNING" && "Nashr qilish mumkin, lekin ogohlantirishlarni tasdiqlash kerak."}
          {policy.verdict === "BLOCKED" && "Nashr qilib bo'lmaydi — avval quyidagilarni tuzating."}
        </span>
      </div>
      {policy.items.length > 0 && (
        <ul className="space-y-1.5">
          {policy.items.map((item, i) => (
            <li key={`${item.code}-${item.nodeId ?? ""}-${i}`} className="flex flex-wrap items-start gap-2 text-sm">
              <Pill tone={item.severity === "BLOCKED" ? "error" : "warning"}>{item.severity}</Pill>
              <span className="min-w-0 flex-1 break-words text-foreground">{item.message}</span>
              {item.nodeId && (
                <button type="button" className="text-xs text-accent hover:underline" onClick={() => onFocus(item.nodeId!)}>
                  {item.nodeId} →
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function AuditPanel({
  evaluation,
  audit,
  policy,
  structural,
  loading,
  stale,
  onRerun,
  onFocus,
}: {
  evaluation?: Evaluation | null;
  audit?: AuditView | null;
  policy?: PolicyView | null;
  structural?: string[];
  loading?: boolean;
  /** The editor has unsaved changes: the shown result is of the saved draft. */
  stale?: boolean;
  onRerun?: () => void;
  onFocus: (nodeId: string) => void;
}) {
  const a = evaluation?.audit ?? audit ?? null;
  const p = evaluation?.policy ?? policy ?? null;
  const gaps = evaluation?.structural ?? structural ?? [];
  if (!a || !p) {
    return (
      <div className="space-y-3 py-6 text-center">
        <p className="text-sm text-muted">Hali tekshirilmagan.</p>
        {onRerun && (
          <button type="button" className={secondaryButton} disabled={loading} onClick={onRerun}>
            {loading ? "Tekshirilmoqda…" : "Auditni ishga tushirish"}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={a.errors.length ? "error" : "success"}>{a.errors.length} xato</Pill>
          <Pill tone={a.warnings.length ? "warning" : "muted"}>{a.warnings.length} ogohlantirish</Pill>
          <Pill tone="muted">{a.suggestions.length} taklif</Pill>
          <VerdictPill verdict={p.verdict} />
        </div>
        {onRerun && (
          <button type="button" className={secondaryButton} disabled={loading} onClick={onRerun}>
            {loading ? "Tekshirilmoqda…" : "Qayta tekshirish"}
          </button>
        )}
      </div>
      {stale && <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">Saqlanmagan o&apos;zgarishlar bor: natija oxirgi saqlangan qoralamaga tegishli. Saqlang — audit yangilanadi.</p>}
      {gaps.length > 0 && (
        <section aria-label="Graf tuzilishi" className="space-y-1 rounded-xl border border-error/30 p-3">
          <h3 className="text-sm font-semibold text-error">Graf to&apos;liq emas</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
            {gaps.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </section>
      )}
      <PolicyBlock policy={p} onFocus={onFocus} />
      <Group title="Xatolar" tone="error" items={a.errors} onFocus={onFocus} />
      <Group title="Ogohlantirishlar" tone="warning" items={a.warnings} onFocus={onFocus} />
      <Group title="Takliflar" tone="muted" items={a.suggestions} onFocus={onFocus} />
      {a.errors.length === 0 && a.warnings.length === 0 && a.suggestions.length === 0 && <p className="text-sm text-success">Auditor hech narsa topmadi.</p>}
    </div>
  );
}
