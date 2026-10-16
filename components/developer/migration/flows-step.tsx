"use client";

import { useState } from "react";
import { Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import FlowDrawer from "./flow-drawer";
import { itemsOf, jsonInit, MIGRATION_API, requestJson, STATUS_TEXT, type MigrationItem, type MigrationMeta, type ProjectDetail } from "./shared";

export default function FlowsStep({
  project,
  meta,
  canWrite,
  enabled,
  onChanged,
  onNext,
}: {
  project: ProjectDetail;
  meta: MigrationMeta;
  canWrite: boolean;
  enabled: boolean;
  onChanged: () => void;
  onNext: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const flows = itemsOf(project, "FLOW");
  const tools = itemsOf(project, "GROWTH_TOOL");
  const open = flows.find((f) => f.id === openId) ?? null;
  const done = flows.filter((f) => f.status === "IMPORTED" || f.status === "SKIPPED").length;

  async function markTool(item: MigrationItem) {
    setToolError(null);
    const status = item.status === "SKIPPED" ? "PENDING" : "SKIPPED";
    const res = await requestJson(`${MIGRATION_API}/projects/${project.id}/items/${item.id}`, jsonInit("PATCH", { status }));
    if (!res.ok) setToolError(res.error);
    onChanged();
  }

  return (
    <div className="space-y-6">
      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="fl-head">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="fl-head" className="text-sm font-semibold text-foreground">
            ManyChat flow&apos;lari
          </h2>
          <Pill tone={flows.length > 0 && done === flows.length ? "success" : "muted"}>
            {done} / {flows.length} tayyor
          </Pill>
        </div>
        <p className="text-xs text-muted">
          ManyChat API flow ichini bermaydi. Har bir flow uchun uning matnini joylang (yoki ekran rasmini yuklang) — AI qoralama flow tuzadi, siz natijani ko&apos;rib, sinab, o&apos;zingiz nashr qilasiz.
        </p>
        {flows.length === 0 ? (
          <p className="text-sm text-muted">Flow topilmadi. Yechim: Tahlil bosqichida &quot;Qayta tahlil qilish&quot; ni bosing.</p>
        ) : (
          <ul className="space-y-2">
            {flows.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-foreground">{f.name}</p>
                  <p className="text-xs text-muted">
                    {f.folder ?? "Papkasiz"} · {f.hasText ? `${f.textLength} belgi matn` : "matn yo'q"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Pill tone={STATUS_TEXT[f.status].tone}>{STATUS_TEXT[f.status].label}</Pill>
                  <button type="button" className={secondaryButton} onClick={() => setOpenId(f.id)} aria-label={`${f.name} flow'ini ochish`}>
                    Ochish
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-labelledby="gt-head">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="gt-head" className="text-sm font-semibold text-foreground">
            Growth tool&apos;lar (qo&apos;lda qayta yaratiladi)
          </h2>
          <Pill tone="muted">{tools.length}</Pill>
        </div>
        <p className="text-xs text-muted">
          Growth tool sozlamalari (kalit so&apos;z, sharoit) API orqali olinmaydi. Ularni SocialAuto&apos;da Comment 2.0 yoki Direct trigger sifatida qayta yarating; tayyor bo&apos;lsa belgilab qo&apos;ying.
        </p>
        {toolError && <p className="text-xs text-error">{toolError}</p>}
        {tools.length === 0 ? (
          <p className="text-sm text-muted">Growth tool topilmadi.</p>
        ) : (
          <ul className="space-y-2">
            {tools.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-foreground">{t.name}</p>
                  <p className="text-xs text-muted">{t.folder ?? "Papkasiz"}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Pill tone={t.status === "SKIPPED" ? "success" : "muted"}>{t.status === "SKIPPED" ? "Qilindi / kerak emas" : "Qo'lda qilinadi"}</Pill>
                  <button type="button" className={secondaryButton} disabled={!canWrite || !enabled} onClick={() => void markTool(t)}>
                    {t.status === "SKIPPED" ? "Qaytarish" : "Belgilash"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex justify-end">
        <button type="button" className={primaryButton} onClick={onNext}>
          Yakunga o&apos;tish
        </button>
      </div>

      {open && (
        <FlowDrawer
          key={open.id}
          project={project}
          item={open}
          meta={meta}
          limits={meta.limits}
          canWrite={canWrite}
          canConvert={canWrite && enabled}
          onClose={() => setOpenId(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}
