"use client";

/** Small form/UI primitives shared by the assistant, leads and integrations pages. */

import type { ReactNode } from "react";

export const inputClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent/40 focus:outline-none disabled:opacity-60";

export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
      {help && <span className="block text-xs text-muted">{help}</span>}
    </label>
  );
}

export function Toggle({
  on,
  onToggle,
  disabled,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
        on ? "border-accent bg-accent/30" : "border-border bg-surface"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full transition-all ${
          on ? "left-6 bg-accent" : "left-1 bg-muted"
        }`}
      />
    </button>
  );
}

export function ToggleRow({
  label,
  help,
  on,
  onToggle,
  disabled,
}: {
  label: string;
  help?: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{label}</p>
        {help && <p className="mt-0.5 text-xs text-muted">{help}</p>}
      </div>
      <Toggle on={on} onToggle={onToggle} disabled={disabled} label={label} />
    </div>
  );
}

type ButtonTone = "primary" | "ghost" | "danger";

const TONE: Record<ButtonTone, string> = {
  primary: "bg-accent text-background hover:bg-accent-hover",
  ghost: "border border-border text-foreground hover:bg-surface-hover",
  danger: "border border-error/30 text-error hover:bg-error/10",
};

export function Button({
  children,
  onClick,
  tone = "primary",
  disabled,
  type = "button",
  href,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  type?: "button" | "submit";
  href?: string;
}) {
  const className = `inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${TONE[tone]}`;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  );
}

type BadgeTone = "success" | "warning" | "error" | "muted" | "accent";

const BADGE: Record<BadgeTone, string> = {
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  error: "bg-error/10 text-error",
  muted: "bg-surface-hover text-muted",
  accent: "bg-accent/10 text-accent",
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${BADGE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Section({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel space-y-4 rounded p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: "error" | "warning" | "success";
  children: ReactNode;
}) {
  const cls = {
    error: "border-error/20 bg-error/10 text-error",
    warning: "border-warning/20 bg-warning/10 text-warning",
    success: "border-success/20 bg-success/10 text-success",
  }[tone];
  return <div className={`rounded border p-3 text-sm ${cls}`}>{children}</div>;
}
