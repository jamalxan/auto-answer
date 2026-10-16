"use client";

import { Pill } from "@/components/developer/ui";
import type { CatalogEntry, ItemWarning, TextAnalysis } from "./shared";

function EntryList({ title, tone, entries, labels }: { title: string; tone: "error" | "warning" | "muted"; entries: ItemWarning[]; labels: Map<string, string> }) {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-2 text-xs font-semibold text-foreground">
        {title} <Pill tone={tone}>{entries.length}</Pill>
      </p>
      <ul className="space-y-1.5">
        {entries.map((e, i) => (
          <li key={`${e.code ?? e.message}-${i}`} className={`rounded-lg border px-3 py-2 text-sm ${tone === "error" ? "border-error/30" : tone === "warning" ? "border-warning/30" : "border-border"}`}>
            <p className="font-medium text-foreground">
              {labels.get(e.feature ?? e.code ?? "") ?? e.feature ?? e.code ?? "Eslatma"}
              {e.count && e.count > 1 ? ` ×${e.count}` : ""}
            </p>
            <p className="text-xs text-muted">{e.message}</p>
            {e.suggestion && <p className="text-xs text-muted">Yechim: {e.suggestion}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Aniqlangan imkoniyatlar": triggers, blocks and UNSUPPORTED / PARTIAL warnings found in the pasted text. */
export default function DetectedPanel({
  analysis,
  catalog,
  loading,
  error,
  empty,
}: {
  analysis: TextAnalysis | null;
  catalog: CatalogEntry[];
  loading: boolean;
  error: string | null;
  empty: boolean;
}) {
  const labels = new Map(catalog.map((c) => [c.key, c.label] as const));
  const label = (kind: string) => labels.get(kind) ?? kind;
  const triggers = analysis?.triggers ?? [];
  const nodes = analysis?.nodes ?? [];
  const problems = analysis?.unsupported ?? [];
  const hard = problems.filter((p) => p.severity === "error");
  const soft = problems.filter((p) => p.severity !== "error");
  const notes = analysis?.notes ?? [];
  const nothing = triggers.length === 0 && nodes.length === 0 && problems.length === 0 && notes.length === 0;
  return (
    <section aria-label="Aniqlangan imkoniyatlar" aria-live="polite" className="space-y-3 rounded-xl border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Aniqlangan imkoniyatlar</h3>
        {loading && <span className="text-xs text-muted">Tekshirilmoqda…</span>}
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
      {empty ? (
        <p className="text-xs text-muted">Matn joylang — shu yerda trigger, bloklar va qo&apos;llab-quvvatlanmaydigan joylar ko&apos;rinadi.</p>
      ) : (
        <>
          {triggers.length > 0 && (
            <div className="text-xs text-muted">
              Trigger:
              <ul className="mt-0.5 list-disc pl-5 text-foreground">
                {triggers.map((t, i) => (
                  <li key={`${t.kind}-${i}`}>
                    {label(t.kind)}
                    {t.detail ? <span className="text-muted"> — {t.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {nodes.length > 0 && (
            <p className="text-xs text-muted">
              Bloklar: <span className="text-foreground">{nodes.map((n) => `${label(n.kind)}${n.count > 1 ? ` ×${n.count}` : ""}`).join(", ")}</span>
            </p>
          )}
          <EntryList title="Qo'llab-quvvatlanmaydi (qo'lda)" tone="error" entries={hard} labels={labels} />
          <EntryList title="Qisman / ogohlantirish" tone="warning" entries={soft} labels={labels} />
          <EntryList title="Eslatmalar" tone="muted" entries={notes} labels={labels} />
          {nothing && !loading && !error && <p className="text-xs text-muted">Aniq ManyChat so&apos;zlari topilmadi — AI baribir matndan taxmin qiladi, natijani tekshiring.</p>}
        </>
      )}
    </section>
  );
}
