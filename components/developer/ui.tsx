"use client";

/**
 * Small building blocks shared by every /developer module screen.
 */

import { usePathname } from "next/navigation";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { DisplayTone } from "@/lib/triggers/display";

// Brand primitives (globals.css): module screens look the same in the main dashboard and in /developer.
export const inputClass = "input placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-violet/60";

export const primaryButton = "btn btn-lime btn-sm";

export const secondaryButton = "btn btn-ghost btn-sm";

const TONE_CLASS: Record<DisplayTone, string> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  muted: "text-muted",
};

export function Pill({ tone, children }: { tone: DisplayTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-current/10 px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ring-current/20 ${TONE_CLASS[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}

/** Marks screens inside /developer only; promoted modules in the main dashboard render nothing. */
export function DevBadge() {
  const pathname = usePathname();
  if (!pathname?.startsWith("/developer")) return null;
  return (
    <span className="label-mono rounded-md bg-gold/15 px-1.5 py-0.5 text-[10px] font-bold text-gold ring-1 ring-inset ring-gold/30">
      DEV
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <span className="label-mono text-[11px] font-semibold text-muted">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  );
}

export function Choice({
  checked,
  disabled,
  onSelect,
  title,
  description,
  badge,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  description?: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={checked}
      className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-accent bg-accent/5" : "border-border hover:border-border-hover"
      }`}
    >
      <span
        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
          checked ? "border-accent" : "border-border-hover"
        }`}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          {title}
          {badge && <span className="label-mono text-[10px] text-muted">{badge}</span>}
        </span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
    </button>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? "bg-accent" : "bg-border-hover"}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-foreground transition-transform ${
          on ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/** Tag input that keeps the keyword as typed (no upper-casing). */
export function ChipInput({
  values,
  onChange,
  placeholder,
  max = 50,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  max?: number;
}) {
  const [draft, setDraft] = useState("");

  function add(raw: string) {
    const parts = raw
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...values];
    for (const part of parts) {
      if (next.length >= max) break;
      if (!next.some((v) => v.toLowerCase() === part.toLowerCase())) next.push(part);
    }
    onChange(next);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5 focus-within:border-accent/40">
      {values.map((value) => (
        <span
          key={value}
          className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent/10 px-2 py-0.5 text-xs font-medium text-foreground"
        >
          <span className="break-all">{value}</span>
          <button
            type="button"
            onClick={() => onChange(values.filter((v) => v !== value))}
            className="text-muted hover:text-foreground"
            aria-label={`${value} ni o'chirish`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (/[,\n]/.test(text)) {
            e.preventDefault();
            add(text);
          }
        }}
        placeholder={values.length === 0 ? placeholder : ""}
        className="min-w-[8rem] flex-1 bg-transparent px-1 py-1 text-sm text-foreground placeholder:text-muted focus:outline-none"
      />
    </div>
  );
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return date.toLocaleString("uz-UZ", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {body && <p className="mt-1 text-sm text-muted">{body}</p>}
    </div>
  );
}
