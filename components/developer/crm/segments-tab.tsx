"use client";

/**
 * Segmentlar (TZ 29): saved filters with the Uzbek sentence and a cached
 * count, and the builder — condition rows per FIELD_SPECS (field / operator /
 * value), "all" and "any" groups, a live preview (count + sample) and save.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Field, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { TemperatureBadge } from "./contacts-tab";
import type { Navigate } from "./crm-dashboard";
import {
  CRM_API,
  jsonInit,
  OP_TEXT,
  requestJson,
  uid,
  type FieldSpec,
  type Meta,
  type SegmentCondition,
  type SegmentFilter,
  type SegmentPreview,
  type SegmentRow,
} from "./shared";

type Draft = SegmentCondition & { key: string };

const EMPTY: SegmentFilter = { v: 1, all: [] };

function specFor(meta: Meta, field: string): FieldSpec | null {
  if (field.startsWith("custom.")) return meta.customFieldSpec;
  return meta.fieldSpecs[field] ?? null;
}

/** Fixed option lists for enum-like fields; free text otherwise. */
function optionsFor(meta: Meta, field: string): { value: string; label: string }[] | null {
  switch (field) {
    case "tag":
    case "not_tag":
      return meta.tags.map((t) => ({ value: t.slug, label: t.name }));
    case "temperature":
      return Object.entries(meta.labels.temperature).map(([value, label]) => ({ value, label }));
    case "status":
      return Object.entries(meta.labels.status).map(([value, label]) => ({ value, label }));
    case "source":
      return Object.entries(meta.labels.source).map(([value, label]) => ({ value, label }));
    case "stage":
      return meta.pipelines.flatMap((p) => p.stages.map((s) => ({ value: s.id, label: meta.pipelines.length > 1 ? `${p.name} · ${s.name}` : s.name })));
    case "pipeline":
      return meta.pipelines.map((p) => ({ value: p.id, label: p.name }));
    case "assigned":
      return meta.members.map((m) => ({ value: m.id, label: m.name || m.email || m.id }));
    case "account":
      return meta.accounts.map((a) => ({ value: a.id, label: `@${a.username}` }));
    case "language":
      return [
        { value: "uz", label: "uz" },
        { value: "ru", label: "ru" },
        { value: "en", label: "en" },
      ];
    default:
      return null;
  }
}

function toConditions(drafts: Draft[]): SegmentCondition[] {
  return drafts.map(({ key: _key, ...cond }) => {
    void _key;
    return cond;
  });
}

function fromConditions(conds: SegmentCondition[] | undefined): Draft[] {
  return (conds ?? []).map((c) => ({ ...c, key: uid() }));
}

function ConditionRow({ meta, cond, onChange, onRemove }: { meta: Meta; cond: Draft; onChange: (next: Draft) => void; onRemove: () => void }) {
  const isCustom = cond.field.startsWith("custom.");
  const spec = specFor(meta, cond.field);
  const options = optionsFor(meta, cond.field);
  const needsValue = cond.op !== "is_true" && cond.op !== "is_false";
  const isList = cond.op === "in";
  const listValue = Array.isArray(cond.value) ? cond.value.map(String) : [];

  function setField(field: string) {
    const nextSpec = specFor(meta, field);
    const op = nextSpec?.ops.includes(cond.op) ? cond.op : (nextSpec?.ops[0] ?? "eq");
    onChange({ ...cond, field, op, value: undefined });
  }

  function setValueText(raw: string) {
    if (spec?.value === "number" || (spec?.value === "any" && raw !== "" && !Number.isNaN(Number(raw)) && cond.op !== "contains")) {
      onChange({ ...cond, value: raw === "" ? undefined : Number(raw) });
    } else onChange({ ...cond, value: raw });
  }

  return (
    <div className="grid grid-cols-1 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-start">
      <div className="flex gap-2">
        <label className="sr-only" htmlFor={`f-${cond.key}`}>
          Maydon
        </label>
        <select id={`f-${cond.key}`} className={inputClass} value={isCustom ? "custom" : cond.field} onChange={(e) => setField(e.target.value === "custom" ? "custom.key" : e.target.value)}>
          {Object.entries(meta.fieldSpecs).map(([field, s]) => (
            <option key={field} value={field}>
              {s.label}
            </option>
          ))}
          <option value="custom">{meta.customFieldSpec.label}</option>
        </select>
      </div>
      {isCustom && (
        <input
          className={inputClass}
          aria-label="Maxsus maydon kaliti"
          placeholder="kalit (city)"
          value={cond.field.slice("custom.".length) === "key" ? "" : cond.field.slice("custom.".length)}
          onChange={(e) => onChange({ ...cond, field: `custom.${e.target.value.replace(/[^A-Za-z0-9_]/g, "")}` })}
        />
      )}
      <div className={isCustom ? "sm:col-start-2" : ""}>
        <label className="sr-only" htmlFor={`o-${cond.key}`}>
          Operator
        </label>
        <select id={`o-${cond.key}`} className={inputClass} value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value, value: e.target.value === "in" ? [] : undefined })}>
          {(spec?.ops ?? ["eq"]).map((op) => (
            <option key={op} value={op}>
              {OP_TEXT[op] ?? op}
            </option>
          ))}
        </select>
      </div>
      <div>
        {!needsValue ? (
          <span className="block py-2 text-xs text-muted">—</span>
        ) : isList ? (
          options ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Qiymatlar">
              {options.map((o) => {
                const on = listValue.includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onChange({ ...cond, value: on ? listValue.filter((v) => v !== o.value) : [...listValue, o.value] })}
                    className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted"}`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          ) : (
            <input
              className={inputClass}
              aria-label="Qiymatlar (vergul bilan)"
              placeholder="a, b, c"
              value={listValue.join(", ")}
              onChange={(e) => onChange({ ...cond, value: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}
            />
          )
        ) : options && cond.op !== "contains" ? (
          <select className={inputClass} aria-label="Qiymat" value={String(cond.value ?? "")} onChange={(e) => onChange({ ...cond, value: e.target.value })}>
            <option value="">Tanlang…</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className={inputClass}
            aria-label="Qiymat"
            type={spec?.value === "number" ? "number" : "text"}
            placeholder={cond.field === "last_interaction" ? "kun" : cond.field === "score" ? "0–100" : "qiymat"}
            value={cond.value === undefined ? "" : String(cond.value)}
            onChange={(e) => setValueText(e.target.value)}
          />
        )}
      </div>
      <button type="button" className={secondaryButton} onClick={onRemove} aria-label="Shartni o'chirish">
        ×
      </button>
    </div>
  );
}

export function SegmentBuilder({
  meta,
  value,
  onChange,
}: {
  meta: Meta;
  value: SegmentFilter;
  onChange: (next: SegmentFilter) => void;
}) {
  const [all, setAll] = useState<Draft[]>(() => fromConditions(value.all));
  const [any, setAny] = useState<Draft[]>(() => fromConditions(value.any));
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const next: SegmentFilter = { v: 1, all: toConditions(all) };
    if (any.length > 0) next.any = toConditions(any);
    onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onChange is stable enough; emit on edits only
  }, [all, any]);

  const add = (setter: typeof setAll) => setter((list) => [...list, { key: uid(), field: "tag", op: "eq", value: undefined }]);

  // A render function, not a nested component: a nested component would remount (and lose focus) on every keystroke.
  function renderGroup(title: string, hint: string, list: Draft[], setter: typeof setAll) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-foreground">{title}</p>
            <p className="text-[11px] text-muted">{hint}</p>
          </div>
          <button type="button" className={secondaryButton} onClick={() => add(setter)}>
            + Shart
          </button>
        </div>
        {list.map((cond) => (
          <ConditionRow
            key={cond.key}
            meta={meta}
            cond={cond}
            onChange={(next) => setter((l) => l.map((c) => (c.key === cond.key ? next : c)))}
            onRemove={() => setter((l) => l.filter((c) => c.key !== cond.key))}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {renderGroup("Hammasi bajarilsin (VA)", "Toshkent + HOT + IELTS + telefon bor", all, setAll)}
      {renderGroup("Kamida bittasi (YOKI)", "Masalan: til uz yoki ru", any, setAny)}
    </div>
  );
}

export function usePreview(filter: SegmentFilter) {
  const [preview, setPreview] = useState<SegmentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const json = JSON.stringify(filter);

  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      const res = await requestJson<SegmentPreview>(`${CRM_API}/segments/preview`, jsonInit("POST", { filter: JSON.parse(json), limit: 10 }));
      if (mine !== seq.current) return;
      if (res.ok) {
        setPreview(res.data);
        setError(null);
      } else setError(res.error);
    }, 400);
    return () => clearTimeout(timer);
  }, [json]);

  return { preview, error };
}

function SegmentEditor({ meta, segment, onDone, onCancel }: { meta: Meta; segment: SegmentRow | null; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [filter, setFilter] = useState<SegmentFilter>(segment?.filter ?? EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { preview, error: previewError } = usePreview(filter);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name, description: description || null, filter };
      const res = segment
        ? await requestJson(`${CRM_API}/segments/${segment.id}`, jsonInit("PATCH", body))
        : await requestJson(`${CRM_API}/segments`, jsonInit("POST", body));
      if (res.ok) onDone();
      else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-semibold text-foreground">{segment ? "Segmentni tahrirlash" : "Yangi segment"}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nomi">
          <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Toshkent HOT IELTS" />
        </Field>
        <Field label="Tavsif (ixtiyoriy)">
          <input className={inputClass} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </div>
      <SegmentBuilder meta={meta} value={filter} onChange={setFilter} />

      <div className="rounded-lg border border-border bg-surface-hover/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-foreground">
            {preview ? (
              <>
                <b>{preview.count}</b> ta kontakt · <span className="text-muted">{preview.sentence}</span>
              </>
            ) : (
              <span className="text-muted">Hisoblanmoqda…</span>
            )}
          </p>
        </div>
        {previewError && <Notice tone="error">{previewError}</Notice>}
        {preview && preview.items.length > 0 && (
          <ul className="mt-2 divide-y divide-border">
            {preview.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
                <span className="text-foreground">{c.username ? `@${c.username}` : c.name || c.id}</span>
                <TemperatureBadge temperature={c.temperature} score={c.score} hasAiState={c.hasAiState} />
                <span className="text-xs text-muted">{c.phoneE164 ?? ""}</span>
                {c.tags.length > 0 && <span className="text-xs text-muted">{c.tags.join(", ")}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? "Saqlanmoqda…" : "Saqlash"}
        </button>
        <button type="button" className={secondaryButton} onClick={onCancel}>
          Bekor
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

export default function SegmentsTab({ meta, navigate, segmentId, onChanged }: { meta: Meta; navigate: Navigate; segmentId: string | null; onChanged: () => void }) {
  const [segments, setSegments] = useState<SegmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<"new" | string | null>(segmentId ? segmentId : null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<{ segments: SegmentRow[] }>(`${CRM_API}/segments`);
    if (mine !== seq.current) return;
    if (res.ok) setSegments(res.data.segments);
    else setError(res.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  async function remove(id: string) {
    const res = await requestJson(`${CRM_API}/segments/${id}`, { method: "DELETE" });
    if (!res.ok) setError(res.error);
    void load();
    onChanged();
  }

  const canManage = meta.me.canManage;
  const done = () => {
    setEditing(null);
    void load();
    onChanged();
  };

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      <section className="panel space-y-3 rounded-xl p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Segmentlar</h2>
            <p className="mt-1 text-xs text-muted">
              Dinamik filtrlar: ro&apos;yxat, eksport va broadcast auditoriyasi bitta shart orqali o&apos;qiladi. Oyna va kunlar har so&apos;rovda qayta
              hisoblanadi.
            </p>
          </div>
          {canManage && editing === null && (
            <button type="button" className={primaryButton} onClick={() => setEditing("new")}>
              + Segment
            </button>
          )}
        </div>

        {editing === "new" && <SegmentEditor meta={meta} segment={null} onDone={done} onCancel={() => setEditing(null)} />}

        {segments === null ? (
          <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : segments.length === 0 ? (
          <EmptyState title="Hali segment yo'q" body="Masalan: Teg HOT + telefon bor + oxirgi 7 kun ichida yozgan." />
        ) : (
          <ul className="divide-y divide-border">
            {segments.map((s) => (
              <li key={s.id} className="py-3">
                {editing === s.id ? (
                  <SegmentEditor meta={meta} segment={s} onDone={done} onCancel={() => setEditing(null)} />
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-foreground">{s.name}</p>
                        <Pill tone="muted">{s.lastCount !== null ? `${s.lastCount} ta` : "sanalmagan"}</Pill>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">{s.sentence}</p>
                      {s.description && <p className="mt-0.5 text-xs text-muted">{s.description}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className={secondaryButton} onClick={() => navigate({ tab: "contacts", segment: s.id })}>
                        Kontaktlar
                      </button>
                      {canManage && (
                        <>
                          <button type="button" className={secondaryButton} onClick={() => setEditing(s.id)}>
                            Tahrirlash
                          </button>
                          <ConfirmButton label="O'chirish" question="Segment o'chirilsinmi?" confirmLabel="O'chirish" danger onConfirm={() => void remove(s.id)} />
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
