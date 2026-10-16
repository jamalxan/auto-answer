"use client";

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { connectFix } from "./connect-step";
import { countOf, itemsOf, KIND_TEXT, MIGRATION_API, requestJson, STATUS_TEXT, type ItemKind, type ProjectDetail } from "./shared";

const KINDS: ItemKind[] = ["TAG", "CUSTOM_FIELD", "BOT_FIELD", "FLOW", "GROWTH_TOOL"];

export default function AnalyzeStep({
  project,
  canWrite,
  onChanged,
  onNext,
}: {
  project: ProjectDetail;
  canWrite: boolean;
  onChanged: () => void;
  onNext: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${MIGRATION_API}/projects/${project.id}/analyze`, { method: "POST" });
      if (!res.ok) setError(connectFix(res.status, res.error));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const analyzed = Boolean(project.lastAnalyzedAt);

  return (
    <div className="space-y-6">
      <section className="panel space-y-4 rounded-xl p-4 sm:p-5" aria-labelledby="an-head">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 id="an-head" className="text-sm font-semibold text-foreground">
              ManyChat&apos;da nima bor
            </h2>
            <p className="text-xs text-muted">
              {analyzed ? `Oxirgi tahlil: ${new Date(project.lastAnalyzedAt!).toLocaleString("uz-UZ")}` : "Hali tahlil qilinmagan — tugmani bosing."} Faqat o&apos;qiladi, ManyChat&apos;da hech narsa o&apos;zgarmaydi.
            </p>
          </div>
          <button type="button" className={analyzed ? secondaryButton : primaryButton} disabled={!canWrite || busy} onClick={() => void analyze()}>
            {busy ? "O'qilmoqda…" : analyzed ? "Qayta tahlil qilish" : "Tahlilni boshlash"}
          </button>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {project.lastError && !error && <Notice tone="error">{project.lastError}</Notice>}

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {KINDS.map((kind) => (
            <div key={kind} className="rounded-lg border border-border px-3 py-2">
              <dt className="text-xs text-muted">{KIND_TEXT[kind]}</dt>
              <dd className="text-xl font-bold text-foreground">{countOf(project, kind)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="an-auto">
        <h2 id="an-auto" className="text-sm font-semibold text-foreground">
          Nima avtomatik, nima qo&apos;lda
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-success/30 p-3 text-sm text-foreground">
            <p className="mb-1 text-xs font-semibold text-success">Avtomatik (keyingi qadam)</p>
            <p>{countOf(project, "TAG")} ta teg, {countOf(project, "CUSTOM_FIELD")} ta maydon va {countOf(project, "BOT_FIELD")} ta bot maydoni import qilinadi.</p>
          </div>
          <div className="rounded-lg border border-warning/30 p-3 text-sm text-foreground">
            <p className="mb-1 text-xs font-semibold text-warning">Qo&apos;lda (matn joylaysiz, AI yordam beradi)</p>
            <p>{countOf(project, "FLOW")} ta flow — har biri uchun matn yoki ekran rasmi. {countOf(project, "GROWTH_TOOL")} ta growth tool — faqat ro&apos;yxat, o&apos;zingiz qayta yaratasiz.</p>
          </div>
        </div>
        {project.todo.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-foreground">Hozir qilish kerak</p>
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted">
              {project.todo.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {KINDS.map((kind) => {
        const items = itemsOf(project, kind);
        return (
          <details key={kind} className="panel rounded-xl p-4 sm:p-5" open={kind === "FLOW" || kind === "GROWTH_TOOL"}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold text-foreground">
              <span>{KIND_TEXT[kind]}</span>
              <Pill tone="muted">{countOf(project, kind)}</Pill>
            </summary>
            {items.length === 0 ? (
              <p className="mt-3 text-sm text-muted">{analyzed ? "Bu turda hech narsa topilmadi." : "Tahlildan keyin shu yerda ko'rinadi."}</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[28rem] text-left text-sm">
                  <caption className="sr-only">{KIND_TEXT[kind]}</caption>
                  <thead>
                    <tr className="text-xs text-muted">
                      <th scope="col" className="py-1 pr-3 font-medium">Nomi</th>
                      <th scope="col" className="py-1 pr-3 font-medium">Papka</th>
                      <th scope="col" className="py-1 font-medium">Holat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="border-t border-border">
                        <td className="max-w-[16rem] break-words py-1.5 pr-3 text-foreground">{item.name}</td>
                        <td className="py-1.5 pr-3 text-muted">{item.folder ?? "—"}</td>
                        <td className="py-1.5">
                          <Pill tone={STATUS_TEXT[item.status].tone}>{STATUS_TEXT[item.status].label}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        );
      })}

      <div className="flex justify-end">
        <button type="button" className={primaryButton} disabled={!analyzed} onClick={onNext}>
          Moslashtirishga o&apos;tish
        </button>
      </div>
    </div>
  );
}
