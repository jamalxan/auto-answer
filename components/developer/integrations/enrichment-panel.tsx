"use client";

/**
 * amoCRM / Bitrix24 enrichment (opt-in, one-way): score into a custom field,
 * `hot` / `warm` tag (amoCRM), a score note, and the CrmStage → CRM status
 * map. It waits for the production lead push, so a lead is never created
 * here. Field / status choices can be loaded live from the CRM; typing the id
 * by hand always works.
 */

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Field, Toggle, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { INTEGRATIONS_API, jsonInit, requestJson, type IntegrationView, type Meta } from "./shared";

interface Options {
  fields: Array<{ id: string | number; name: string }>;
  statuses: Array<{ id: string | number; name: string }>;
}

export default function EnrichmentPanel({
  integration,
  meta,
  onChanged,
}: {
  integration: IntegrationView;
  meta: Meta;
  onChanged: () => void;
}) {
  const isAmo = integration.type === "AMOCRM";
  const current = integration.enrichment ?? { enabled: false, scoreFieldId: null, temperatureTag: true, stageMap: {} };
  const [enabled, setEnabled] = useState(current.enabled);
  const [scoreField, setScoreField] = useState(current.scoreFieldId === null ? "" : String(current.scoreFieldId));
  const [temperatureTag, setTemperatureTag] = useState(current.temperatureTag);
  const [stageMap, setStageMap] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(current.stageMap).map(([k, v]) => [k, String(v)]))
  );
  const [options, setOptions] = useState<Options | null>(null);
  const [busy, setBusy] = useState<"save" | "load" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function loadOptions() {
    setBusy("load");
    setError(null);
    try {
      const res = await requestJson<Options>(`${INTEGRATIONS_API}/${integration.id}/enrichment-options`);
      if (res.ok) setOptions(res.data);
      else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setError(null);
    setSaved(false);
    try {
      const map: Record<string, string | number> = {};
      for (const [stage, status] of Object.entries(stageMap)) {
        const text = status.trim();
        if (!text) continue;
        map[stage] = isAmo ? Number(text) : text;
      }
      if (isAmo && Object.values(map).some((v) => !Number.isInteger(v))) {
        setError("amoCRM status ID raqam bo'lishi kerak");
        return;
      }
      const field = scoreField.trim();
      const res = await requestJson(
        `${INTEGRATIONS_API}/${integration.id}/enrichment`,
        jsonInit("PATCH", {
          enabled,
          temperatureTag,
          stageMap: map,
          scoreFieldId: field === "" ? null : isAmo ? Number(field) : field,
        })
      );
      if (res.ok) {
        setSaved(true);
        onChanged();
      } else setError(res.error);
    } finally {
      setBusy(null);
    }
  }

  const stageNames = Array.from(new Set(meta.stages.map((s) => s.name)));

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3" aria-label="Boyitish sozlamalari">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">CRM boyitish (ixtiyoriy)</p>
          <p className="text-xs text-muted">
            {(isAmo ? meta.enrichment.amo : meta.enrichment.bitrix).join(" · ")}. Yangi lead yaratmaydi — avval lead yetkazilishini kutadi.
          </p>
        </div>
        <Toggle on={enabled} onChange={setEnabled} label="Boyitishni yoqish" />
      </div>

      {enabled && (
        <div className="space-y-3">
          <Field label={isAmo ? "Ball maydoni (lead custom field ID)" : "Ball maydoni (UF_CRM_… kodi)"} hint="Bo'sh bo'lsa ball faqat izohda yoziladi.">
            {options && options.fields.length > 0 ? (
              <select className={inputClass} value={scoreField} onChange={(e) => setScoreField(e.target.value)}>
                <option value="">— tanlanmagan —</option>
                {options.fields.map((f) => (
                  <option key={String(f.id)} value={String(f.id)}>
                    {f.name} ({String(f.id)})
                  </option>
                ))}
              </select>
            ) : (
              <input className={inputClass} value={scoreField} onChange={(e) => setScoreField(e.target.value)} placeholder={isAmo ? "123456" : "UF_CRM_SCORE"} />
            )}
          </Field>

          {isAmo && (
            <label className="flex items-center gap-3 text-sm text-foreground">
              <Toggle on={temperatureTag} onChange={setTemperatureTag} label="hot / warm tegi" />
              <span>Leadga «hot» / «warm» teg qo&apos;yish</span>
            </label>
          )}

          <Field label="Bosqich → status" hint="Deal CRM'da shu bosqichga o'tganda amoCRM / Bitrix24 lead holati o'zgaradi. Bo'sh qoldirilgan bosqich o'tkazib yuboriladi.">
            <div className="space-y-2">
              {stageNames.length === 0 && <p className="text-xs text-muted">CRM pipeline hali yo&apos;q — avval CRM bo&apos;limida bosqichlarni yarating.</p>}
              {stageNames.map((stage) => (
                <div key={stage} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                  <span className="truncate text-sm text-foreground">{stage}</span>
                  {options && options.statuses.length > 0 ? (
                    <select
                      aria-label={`${stage} uchun status`}
                      className={inputClass}
                      value={stageMap[stage] ?? ""}
                      onChange={(e) => setStageMap({ ...stageMap, [stage]: e.target.value })}
                    >
                      <option value="">— o&apos;tkazib yuborish —</option>
                      {options.statuses.map((s) => (
                        <option key={String(s.id)} value={String(s.id)}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      aria-label={`${stage} uchun status`}
                      className={inputClass}
                      value={stageMap[stage] ?? ""}
                      onChange={(e) => setStageMap({ ...stageMap, [stage]: e.target.value })}
                      placeholder={isAmo ? "status ID" : "STATUS_ID (masalan, IN_PROCESS)"}
                    />
                  )}
                </div>
              ))}
            </div>
          </Field>

          <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void loadOptions()}>
            {busy === "load" ? "CRM'dan olinmoqda…" : "Maydon va statuslarni CRM'dan yuklash"}
          </button>
        </div>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {saved && !error && <Notice tone="info">Saqlandi.</Notice>}
      <button type="button" className={primaryButton} disabled={busy !== null || !meta.me.canWrite} onClick={() => void save()}>
        {busy === "save" ? "Saqlanmoqda…" : "Boyitishni saqlash"}
      </button>
    </div>
  );
}
