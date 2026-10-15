"use client";

/**
 * Layout pieces of the Comment 2.0 screens: numbered builder sections, the
 * collapsed "Kengaytirilgan" block, inline confirms and notices.
 */

import { useState, type ReactNode } from "react";
import { secondaryButton } from "@/components/developer/ui";

export function Section({
  index,
  title,
  description,
  aside,
  children,
}: {
  index: number;
  title: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `section-${index}`;
  return (
    <section aria-labelledby={headingId} className="panel space-y-4 rounded-xl p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-bold text-accent">
              {index}
            </span>
            {title}
          </h2>
          {description && <p className="mt-1 text-xs text-muted">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Progressive disclosure: advanced settings stay folded until asked for. */
export function Advanced({ children, label = "Kengaytirilgan" }: { children: ReactNode; label?: string }) {
  return (
    <details className="group rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-muted hover:text-foreground">
        {label}
        <span aria-hidden="true" className="transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="space-y-4 border-t border-border p-3">{children}</div>
    </details>
  );
}

export function Notice({ tone, children }: { tone: "info" | "warning" | "error"; children: ReactNode }) {
  const cls =
    tone === "error"
      ? "border-error/30 bg-error/10 text-error"
      : tone === "warning"
        ? "border-warning/30 bg-warning/10 text-warning"
        : "border-border bg-surface-hover/50 text-muted";
  return (
    <div role={tone === "error" ? "alert" : undefined} className={`rounded-lg border px-3 py-2 text-xs ${cls}`}>
      {children}
    </div>
  );
}

export function CharCount({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return (
    <span className={`text-[11px] tabular-nums ${over ? "text-error" : "text-muted"}`}>
      {value.length}/{max}
    </span>
  );
}

/**
 * Two-step button: the first click asks, the second does. Used instead of
 * window.confirm for anything that deletes or sends.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel = "Ha",
  busy,
  disabled,
  danger,
  onConfirm,
}: {
  label: string;
  question: string;
  confirmLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={secondaryButton} disabled={disabled || busy} onClick={() => setAsking(true)}>
        {busy ? "Kuting…" : label}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-border px-2 py-1 text-xs" role="group">
      <span className="text-foreground">{question}</span>
      <button
        type="button"
        className={`rounded-md px-2 py-1 font-semibold ${danger ? "bg-error/15 text-error" : "bg-accent/15 text-accent"}`}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="rounded-md px-2 py-1 text-muted hover:text-foreground" onClick={() => setAsking(false)}>
        Yo&apos;q
      </button>
    </span>
  );
}
