"use client";

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { inputClass, Pill, primaryButton, secondaryButton, Toggle } from "@/components/developer/ui";
import {
  itemsOf,
  jsonInit,
  KIND_TEXT,
  MIGRATION_API,
  requestJson,
  str,
  STATUS_TEXT,
  type ItemKind,
  type MigrationItem,
  type ProjectDetail,
} from "./shared";

const FIELD_TYPES: Array<[string, string]> = [
  ["string", "Matn"],
  ["number", "Son"],
  ["boolean", "Ha / yo'q"],
  ["date", "Sana"],
  ["list", "Ro'yxat"],
];

/** The mapping key each kind edits (engine: targetSlug / key / varKey). */
const KEY_OF: Record<string, string> = { TAG: "targetSlug", CUSTOM_FIELD: "key", BOT_FIELD: "varKey" };

/** One editable mapping row; keeps a local draft and shows an unsaved marker until saved. */
function MappingRow({ projectId, item, canWrite, onSaved }: { projectId: string; item: MigrationItem; canWrite: boolean; onSaved: () => void }) {
  const m = item.mapping ?? {};
  const keyName = KEY_OF[item.kind] ?? "key";
  const saved = { target: str(m[keyName]), type: str(m.type, "string"), value: str(m.value) };
  const [target, setTarget] = useState(saved.target);
  const [type, setType] = useState(saved.type);
  const [value, setValue] = useState(saved.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = !canWrite || busy || item.status === "IMPORTED";
  const skipped = item.status === "SKIPPED";
  const dirty = target !== saved.target || type !== saved.type || value !== saved.value;

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`${MIGRATION_API}/projects/${projectId}/items/${item.id}`, jsonInit("PATCH", body));
      if (res.ok) onSaved();
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    // Only what changed: the engine validates and merges it into the stored mapping.
    const mapping: Record<string, unknown> = {};
    if (target !== saved.target) mapping[keyName] = target;
    if (item.kind === "CUSTOM_FIELD" && type !== saved.type) mapping.type = type;
    if (item.kind === "BOT_FIELD" && value !== saved.value) mapping.value = value;
    void patch({ mapping });
  }

  const label = (suffix: string) => `${item.name}: ${suffix}`;
  const action = str(m.action);
  return (
    <li className={`space-y-2 rounded-lg border border-border px-3 py-2 ${skipped ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words text-sm font-medium text-foreground">{item.name}</p>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && <span className="text-xs text-warning">Saqlanmagan</span>}
          {item.kind === "TAG" && action && !skipped && <Pill tone="muted">{action === "merge" ? "Mavjud teg bilan birlashadi" : "Yangi yaratiladi"}</Pill>}
          <Pill tone={STATUS_TEXT[item.status].tone}>{STATUS_TEXT[item.status].label}</Pill>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input
          className={inputClass}
          value={target}
          maxLength={60}
          disabled={locked || skipped}
          onChange={(e) => setTarget(e.target.value)}
          aria-label={label(item.kind === "TAG" ? "maqsad teg (slug)" : item.kind === "CUSTOM_FIELD" ? "maydon kaliti" : "o'zgaruvchi kaliti")}
        />
        {item.kind === "TAG" && <span className="self-center text-xs text-muted">Mavjud teg bilan nom to&apos;qnashsa birlashtiriladi.</span>}
        {item.kind === "CUSTOM_FIELD" && (
          <select className={inputClass} value={type} disabled={locked || skipped} onChange={(e) => setType(e.target.value)} aria-label={label("turi")}>
            {(FIELD_TYPES.some(([v]) => v === type) ? FIELD_TYPES : [...FIELD_TYPES, [type, type] as [string, string]]).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        )}
        {item.kind === "BOT_FIELD" && (
          <input className={inputClass} value={value} maxLength={500} disabled={locked || skipped} onChange={(e) => setValue(e.target.value)} aria-label={label("qiymat")} />
        )}
        <button type="button" className={secondaryButton} disabled={locked || skipped || !dirty || !target.trim()} onClick={save}>
          {busy ? "Saqlanmoqda…" : "Saqlash"}
        </button>
      </div>
      {item.status !== "IMPORTED" && (
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={skipped} disabled={!canWrite || busy} onChange={(e) => void patch({ status: e.target.checked ? "SKIPPED" : "MAPPED" })} aria-label={label("o'tkazib yuborish")} />
          O&apos;tkazib yuborish (import qilinmaydi)
        </label>
      )}
      {item.note && <p className="text-xs text-muted">{item.note}</p>}
      {error && <p className="text-xs text-error">{error}</p>}
    </li>
  );
}

function Table({ project, kind, canWrite, onChanged, hint }: { project: ProjectDetail; kind: ItemKind; canWrite: boolean; onChanged: () => void; hint: string }) {
  const items = itemsOf(project, kind);
  return (
    <section className="panel space-y-3 rounded-xl p-4 sm:p-5" aria-label={KIND_TEXT[kind]}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{KIND_TEXT[kind]}</h2>
        <Pill tone="muted">{items.length}</Pill>
      </div>
      <p className="text-xs text-muted">{hint}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted">Hech narsa topilmadi.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <MappingRow key={`${item.id}-${JSON.stringify(item.mapping)}`} projectId={project.id} item={item} canWrite={canWrite} onSaved={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ImportResult {
  tags: { created: number; merged: number; failed: number } | null;
  customFields: { imported: number; failed: number } | null;
  botFields: { imported: number; failed: number } | null;
}

export default function MappingStep({
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
  const [toggles, setToggles] = useState({ tags: true, customFields: true, botFields: true });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function runImport() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson<ImportResult>(`${MIGRATION_API}/projects/${project.id}/import-basics`, jsonInit("POST", toggles));
      if (res.ok) {
        setResult(res.data);
        setConfirming(false);
        onChanged();
      } else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  const nothing = !toggles.tags && !toggles.customFields && !toggles.botFields;

  return (
    <div className="space-y-6">
      <Table project={project} kind="TAG" canWrite={canWrite} onChanged={onChanged} hint="ManyChat tegi → SocialAuto CRM tegi (slug). Mavjud teg bilan nom to'qnashsa, u birlashtiriladi, ikkilanmaydi." />
      <Table project={project} kind="CUSTOM_FIELD" canWrite={canWrite} onChanged={onChanged} hint="Maydon kaliti kontaktning customFields ichida ishlatiladi (faqat harf, raqam, pastki chiziq)." />
      <Table project={project} kind="BOT_FIELD" canWrite={canWrite} onChanged={onChanged} hint="Bot maydonlari flow o'zgaruvchisi bo'ladi; qiymatini shu yerda o'zgartirishingiz mumkin." />

      <section className="panel space-y-4 rounded-xl p-4 sm:p-5" aria-labelledby="mp-import">
        <h2 id="mp-import" className="text-sm font-semibold text-foreground">
          Teglar va maydonlarni import qilish
        </h2>
        <div className="space-y-2">
          {(
            [
              ["tags", "Teglar → CRM teglari"],
              ["customFields", "Maxsus maydonlar → kontakt maydonlari"],
              ["botFields", "Bot maydonlari → flow o'zgaruvchilari"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <span className="text-sm text-foreground">{label}</span>
              <Toggle on={toggles[key]} label={label} onChange={(on) => setToggles((t) => ({ ...t, [key]: on }))} />
            </div>
          ))}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {result && (
          <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-foreground" role="status">
            <p className="font-semibold text-success">Import bajarildi</p>
            <ul className="mt-1 space-y-0.5">
              {result.tags && (
                <li>
                  Teglar: <strong>{result.tags.created}</strong> yaratildi, <strong>{result.tags.merged}</strong> birlashtirildi{result.tags.failed ? `, ${result.tags.failed} xato` : ""}
                </li>
              )}
              {result.customFields && (
                <li>
                  Maxsus maydonlar: <strong>{result.customFields.imported}</strong> moslandi{result.customFields.failed ? `, ${result.customFields.failed} xato (kalitni tuzating)` : ""}
                </li>
              )}
              {result.botFields && (
                <li>
                  Bot maydonlari: <strong>{result.botFields.imported}</strong> o&apos;zgaruvchi{result.botFields.failed ? `, ${result.botFields.failed} xato (kalitni tuzating)` : ""}
                </li>
              )}
            </ul>
          </div>
        )}
        {confirming ? (
          <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3" role="group" aria-label="Importni tasdiqlash">
            <p className="text-sm text-foreground">Tanlangan teglar CRM&apos;ga yaratiladi, maydonlar va o&apos;zgaruvchilar saqlanadi. Mavjud ma&apos;lumot o&apos;chirilmaydi. Davom etasizmi?</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={primaryButton} disabled={busy} onClick={() => void runImport()}>
                {busy ? "Import qilinmoqda…" : "Ha, import qilish"}
              </button>
              <button type="button" className={secondaryButton} disabled={busy} onClick={() => setConfirming(false)}>
                Bekor qilish
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={primaryButton} disabled={!canWrite || nothing} onClick={() => setConfirming(true)}>
            Import qilish…
          </button>
        )}
      </section>

      <div className="flex justify-end">
        <button type="button" className={secondaryButton} onClick={onNext}>
          Flow&apos;larga o&apos;tish
        </button>
      </div>
    </div>
  );
}
