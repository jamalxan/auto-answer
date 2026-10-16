"use client";

/**
 * Condition builder of the `condition` block: same idea as the CRM segment
 * builder (field / operator / value rows, "all" and "any" groups), with the
 * flow DSL of lib/flows/conditions (keyword / intent operators, vars.<key>).
 */

import { inputClass, secondaryButton } from "@/components/developer/ui";
import { FIELD_SPECS, fieldSpec, type FlowCondition, type FlowFilter } from "@/lib/flows/conditions";
import type { FlowsMeta } from "./shared";

const OP_TEXT: Record<string, string> = {
  eq: "teng",
  neq: "teng emas",
  in: "ro'yxatdan biri",
  gte: "kamida (≥)",
  lte: "ko'pi bilan (≤)",
  contains: "ichida bor",
  is_set: "to'ldirilgan",
  not_set: "bo'sh",
  keyword: "kalit so'z bor",
  intent: "niyat shunday",
};

const ENUM_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  temperature: [
    { value: "COLD", label: "Sovuq" },
    { value: "WARM", label: "Iliq" },
    { value: "HOT", label: "Issiq" },
  ],
  audience: [
    { value: "NEW_CONTACT", label: "Yangi kontakt" },
    { value: "RETURNING_CONTACT", label: "Qaytgan kontakt" },
    { value: "REOPENED", label: "Qayta ochilgan" },
  ],
  "trigger.source": [
    { value: "ADS", label: "Reklama" },
    { value: "LINK", label: "ig.me havola" },
    { value: "organic", label: "Organik" },
  ],
  "contact.language": [
    { value: "uz", label: "uz" },
    { value: "ru", label: "ru" },
    { value: "en", label: "en" },
  ],
};

const DEFAULT_CONDITION: FlowCondition = { field: "contact.phone", op: "is_set" };

function listText(value: FlowCondition["value"]): string {
  return Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
}

function ConditionRow({
  meta,
  graphVars,
  cond,
  index,
  onChange,
  onRemove,
}: {
  meta: FlowsMeta | null;
  graphVars: string[];
  cond: FlowCondition;
  index: number;
  onChange: (next: FlowCondition) => void;
  onRemove: () => void;
}) {
  const spec = fieldSpec(cond.field) ?? FIELD_SPECS["contact.phone"];
  const isVars = cond.field.startsWith("vars.");
  const noValue = cond.op === "is_set" || cond.op === "not_set";
  const enumOptions = ENUM_OPTIONS[cond.field];

  function setField(field: string) {
    const next = fieldSpec(field);
    const op = next?.ops.includes(cond.op) ? cond.op : (next?.ops[0] ?? "eq");
    onChange({ field, op, value: op === "is_set" || op === "not_set" ? undefined : defaultValue(field, op) });
  }

  function defaultValue(field: string, op: string): FlowCondition["value"] {
    const s = fieldSpec(field);
    if (op === "gte" || op === "lte" || (s?.value === "number" && op !== "in")) return 0;
    if (s?.value === "boolean") return true;
    if (op === "in") return s?.value === "number" ? [0] : [""];
    if (op === "intent") return meta?.intents[0]?.key ?? "price";
    return "";
  }

  function setValueText(raw: string) {
    if (cond.op === "in") {
      const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
      const nums = spec.value === "number" ? parts.map(Number).filter((n) => Number.isFinite(n)) : parts;
      return onChange({ ...cond, value: nums.length ? nums : spec.value === "number" ? [0] : [""] });
    }
    if (cond.op === "keyword") {
      const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
      return onChange({ ...cond, value: parts.length > 1 ? parts : (parts[0] ?? "") });
    }
    if (cond.op === "gte" || cond.op === "lte" || (spec.value === "number" && cond.op !== "contains")) {
      return onChange({ ...cond, value: raw === "" ? 0 : Number(raw) });
    }
    onChange({ ...cond, value: raw });
  }

  const intentValues = Array.isArray(cond.value) ? cond.value.map(String) : cond.value ? [String(cond.value)] : [];

  return (
    <div className="grid grid-cols-1 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-start">
      <div className="space-y-1.5">
        <select aria-label={`${index + 1}-shart: maydon`} className={inputClass} value={isVars ? "vars" : cond.field} onChange={(e) => setField(e.target.value === "vars" ? `vars.${graphVars[0] ?? "phone"}` : e.target.value)}>
          {Object.entries(FIELD_SPECS).map(([field, s]) => (
            <option key={field} value={field}>
              {s.label}
            </option>
          ))}
          <option value="vars">O&apos;zgaruvchi (vars.)</option>
        </select>
        {isVars && (
          <>
            <input
              className={inputClass}
              aria-label="O'zgaruvchi nomi"
              list="flow-vars"
              placeholder="phone"
              value={cond.field.slice(5)}
              onChange={(e) => onChange({ ...cond, field: `vars.${e.target.value.replace(/[^a-z0-9_]/g, "")}` })}
            />
            <datalist id="flow-vars">
              {graphVars.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </>
        )}
      </div>
      <select
        aria-label={`${index + 1}-shart: operator`}
        className={inputClass}
        value={cond.op}
        onChange={(e) => {
          const op = e.target.value as FlowCondition["op"];
          onChange({ field: cond.field, op, value: op === "is_set" || op === "not_set" ? undefined : defaultValue(cond.field, op) });
        }}
      >
        {spec.ops.map((op) => (
          <option key={op} value={op}>
            {OP_TEXT[op] ?? op}
          </option>
        ))}
      </select>
      <div>
        {noValue ? (
          <span className="block py-2 text-xs text-muted">—</span>
        ) : cond.op === "intent" ? (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Niyatlar">
            {(meta?.intents ?? []).map((intent) => {
              const on = intentValues.includes(intent.key);
              return (
                <button
                  key={intent.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const next = on ? intentValues.filter((v) => v !== intent.key) : [...intentValues, intent.key];
                    onChange({ ...cond, value: next.length > 1 ? next : (next[0] ?? "") });
                  }}
                  className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted"}`}
                >
                  {intent.label}
                </button>
              );
            })}
          </div>
        ) : spec.value === "boolean" ? (
          <select aria-label="Qiymat" className={inputClass} value={String(cond.value ?? true)} onChange={(e) => onChange({ ...cond, value: e.target.value === "true" })}>
            <option value="true">Ha (ochiq)</option>
            <option value="false">Yo&apos;q (yopiq)</option>
          </select>
        ) : enumOptions && cond.op !== "in" ? (
          <select aria-label="Qiymat" className={inputClass} value={String(cond.value ?? "")} onChange={(e) => onChange({ ...cond, value: e.target.value })}>
            <option value="">Tanlang…</option>
            {enumOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              className={inputClass}
              aria-label="Qiymat"
              list={cond.field === "tags" ? "flow-tag-slugs" : undefined}
              type={(spec.value === "number" || cond.op === "gte" || cond.op === "lte") && cond.op !== "in" ? "number" : "text"}
              placeholder={cond.op === "in" || cond.op === "keyword" ? "a, b, c" : "qiymat"}
              value={cond.op === "in" || cond.op === "keyword" ? listText(cond.value) : cond.value === undefined ? "" : String(cond.value)}
              onChange={(e) => setValueText(e.target.value)}
            />
            {cond.field === "tags" && (
              <datalist id="flow-tag-slugs">
                {(meta?.tags ?? []).map((t) => (
                  <option key={t.id} value={t.slug} />
                ))}
              </datalist>
            )}
          </>
        )}
      </div>
      <button type="button" className={secondaryButton} onClick={onRemove} aria-label={`${index + 1}-shartni o'chirish`}>
        ×
      </button>
    </div>
  );
}

function Group({
  title,
  hint,
  list,
  meta,
  graphVars,
  onChange,
  max,
}: {
  title: string;
  hint: string;
  list: FlowCondition[];
  meta: FlowsMeta | null;
  graphVars: string[];
  onChange: (next: FlowCondition[]) => void;
  max: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-foreground">{title}</p>
          <p className="text-[11px] text-muted">{hint}</p>
        </div>
        <button type="button" className={secondaryButton} disabled={list.length >= max} onClick={() => onChange([...list, { ...DEFAULT_CONDITION }])}>
          + Shart
        </button>
      </div>
      {list.map((cond, i) => (
        <ConditionRow
          key={i}
          index={i}
          meta={meta}
          graphVars={graphVars}
          cond={cond}
          onChange={(next) => onChange(list.map((c, j) => (j === i ? next : c)))}
          onRemove={() => onChange(list.filter((_, j) => j !== i))}
        />
      ))}
    </div>
  );
}

export default function ConditionBuilder({
  meta,
  graphVars,
  value,
  onChange,
}: {
  meta: FlowsMeta | null;
  graphVars: string[];
  value: FlowFilter;
  onChange: (next: FlowFilter) => void;
}) {
  const any = value.any ?? [];
  return (
    <div className="space-y-3">
      <Group
        title="Hammasi mos kelishi kerak"
        hint="Bo'sh bo'lsa, bu tarmoq har doim tanlanadi."
        list={value.all}
        meta={meta}
        graphVars={graphVars}
        max={50}
        onChange={(all) => onChange({ ...value, all })}
      />
      <Group
        title="Yoki shulardan kamida bittasi"
        hint="Ixtiyoriy."
        list={any}
        meta={meta}
        graphVars={graphVars}
        max={50}
        onChange={(next) => onChange(next.length ? { ...value, any: next } : { v: 1, all: value.all })}
      />
    </div>
  );
}
