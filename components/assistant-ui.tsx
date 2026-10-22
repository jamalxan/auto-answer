"use client";

/**
 * Small form/UI primitives shared by the assistant, leads, integrations and
 * diagnostics pages. Styled from the brand tokens: pill inputs and buttons,
 * filled (not outlined) tones, insets instead of hairline boxes.
 */

import type { ReactNode } from "react";

export const inputClass = "input";

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
    <label className="block space-y-1.5">
      <span className="block text-sm font-semibold text-white">{label}</span>
      {children}
      {help && <span className="block text-xs leading-5 text-muted">{help}</span>}
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
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-violet" : "bg-white/15"
      }`}
    >
      <span
        className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-all ${
          on ? "left-6" : "left-1"
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
    <div className="inset flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{label}</p>
        {help && <p className="mt-0.5 text-xs leading-5 text-muted">{help}</p>}
      </div>
      <Toggle on={on} onToggle={onToggle} disabled={disabled} label={label} />
    </div>
  );
}

type ButtonTone = "primary" | "lime" | "ghost" | "danger";

const TONE: Record<ButtonTone, string> = {
  primary: "btn-primary",
  lime: "btn-lime",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

export function Button({
  children,
  onClick,
  tone = "primary",
  disabled,
  type = "button",
  href,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  type?: "button" | "submit";
  href?: string;
  className?: string;
}) {
  const cls = `btn btn-sm ${TONE[tone]} ${className}`;
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={cls}>
      {children}
    </button>
  );
}

type BadgeTone = "success" | "warning" | "error" | "muted" | "accent";

const BADGE: Record<BadgeTone, string> = {
  success: "bg-lime/15 text-lime",
  warning: "bg-warning/15 text-warning",
  error: "bg-error/15 text-error",
  muted: "bg-white/10 text-muted",
  accent: "bg-violet/25 text-white",
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${BADGE[tone]}`}
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
    <section className="panel space-y-4 rounded-3xl p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-white">{title}</h2>
          {description && <p className="mt-1 text-sm leading-6 text-muted">{description}</p>}
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
    error: "bg-error/12 text-error",
    warning: "bg-warning/12 text-warning",
    success: "bg-lime/12 text-lime",
  }[tone];
  return <div className={`rounded-2xl p-4 text-sm leading-6 ${cls}`}>{children}</div>;
}
