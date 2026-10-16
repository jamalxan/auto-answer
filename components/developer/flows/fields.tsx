"use client";

/**
 * Small form controls of the Flow Builder: labelled inputs, a template text
 * field with variable chips ({{name}} …), a number field with units.
 */

import { useId, useRef, type ReactNode } from "react";
import { CharCount } from "@/components/developer/comments/parts";
import { inputClass } from "@/components/developer/ui";
import { validateTemplateKeys } from "@/lib/flows/variables";
import type { VariableChip } from "./graph-edit";

export function Labeled({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 text-sm ${className}`}>
      <span className="label-mono text-[11px] font-semibold text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function TextInput({
  label,
  value,
  onChange,
  placeholder,
  max,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  max?: number;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Labeled label={label} hint={hint}>
      <input className={inputClass} value={value} maxLength={max} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </Labeled>
  );
}

export function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  unit,
  hint,
  disabled,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Labeled label={label} hint={hint}>
      <span className="flex items-center gap-2">
        <input
          className={inputClass}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          disabled={disabled}
          value={value === undefined ? "" : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return onChange(undefined);
            const n = Math.trunc(Number(raw));
            if (Number.isFinite(n)) onChange(n);
          }}
        />
        {unit && <span className="shrink-0 text-xs text-muted">{unit}</span>}
      </span>
    </Labeled>
  );
}

export function SelectInput<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Labeled label={label} hint={hint}>
      <select className={inputClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Labeled>
  );
}

/** Textarea / input for a `{{template}}` text with insertable variable chips and an unknown-key warning. */
export function TemplateField({
  label,
  value,
  onChange,
  max,
  chips,
  declared,
  rows = 3,
  optional,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  chips: VariableChip[];
  /** Keys declared in graph.variables (so `vars.x` is known). */
  declared: string[];
  rows?: number;
  optional?: boolean;
  hint?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const unknown = validateTemplateKeys(value, declared);

  function insert(token: string) {
    const el = ref.current;
    const text = `{{${token}}}`;
    if (!el) return onChange(`${value}${text}`);
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="label-mono text-[11px] font-semibold text-muted">
          {label}
          {optional && <span className="ml-1 font-normal normal-case">(ixtiyoriy)</span>}
        </label>
        <CharCount value={value} max={max} />
      </div>
      <textarea id={id} ref={ref} rows={rows} className={`${inputClass} resize-y`} value={value} onChange={(e) => onChange(e.target.value)} />
      <div className="flex flex-wrap gap-1" role="group" aria-label="O'zgaruvchilarni qo'shish">
        {chips.map((chip) => (
          <button
            key={chip.token}
            type="button"
            onClick={() => insert(chip.token)}
            title={`{{${chip.token}}}`}
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted hover:border-accent/40 hover:text-foreground"
          >
            {chip.label}
          </button>
        ))}
      </div>
      {unknown.length > 0 && (
        <span className="text-xs text-error">
          Noma&apos;lum o&apos;zgaruvchi: {unknown.map((k) => `{{${k}}}`).join(", ")}
        </span>
      )}
      {hint && unknown.length === 0 && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}
