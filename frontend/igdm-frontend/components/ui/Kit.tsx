import type { ReactNode } from "react";
import Icon from "./Icon";

/* ── Bay: a milled slot on the panel. Every card in the product is a bay. ── */
export function Bay({
  label,
  index,
  right,
  paper = false,
  className = "",
  children,
}: {
  label?: string;
  /** only pass an index where the order is real (funnel steps, priority) */
  index?: string;
  right?: ReactNode;
  paper?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-bay
      className={`relative ${
        paper ? "worktop on-paper" : "plate rounded-bay"
      } ${className}`}
    >
      {(label || right) && (
        <header
          className={`flex items-center justify-between gap-3 px-4 py-2.5 border-b ${
            paper ? "border-ink/15" : "border-line"
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            {index && (
              <span
                className="util px-1.5 py-0.5 shrink-0"
                style={{ background: "var(--c-saffron)", color: "var(--c-field-deep)" }}
              >
                {index}
              </span>
            )}
            <h2 className={`util truncate ${paper ? "text-ink-soft" : "text-paper/70"}`}>
              {label}
            </h2>
          </div>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/* ── StatusPill: colour is never the only signal — every state has a word ── */
const TONE: Record<string, { c: string; on: string }> = {
  active: { c: "var(--s-active)", on: "var(--c-field-deep)" },
  completed: { c: "var(--s-active)", on: "var(--c-field-deep)" },
  paused: { c: "var(--s-paused)", on: "var(--c-field-deep)" },
  gate_pending: { c: "var(--s-paused)", on: "var(--c-field-deep)" },
  awaiting_confirm: { c: "var(--s-paused)", on: "var(--c-field-deep)" },
  failed: { c: "var(--s-failed)", on: "var(--c-paper)" },
  undeliverable: { c: "var(--s-failed)", on: "var(--c-paper)" },
  declined: { c: "var(--c-ink-soft)", on: "var(--c-paper)" },
  abandoned: { c: "var(--c-ink-soft)", on: "var(--c-paper)" },
  draft: { c: "var(--s-draft)", on: "var(--c-field-deep)" },
  archived: { c: "var(--s-draft)", on: "var(--c-field-deep)" },
  opened: { c: "var(--c-wrong)", on: "var(--c-paper)" },
  // CommentEvent.match_result / public_reply_status / Lead.gate_result
  matched: { c: "var(--s-active)", on: "var(--c-field-deep)" },
  sent: { c: "var(--s-active)", on: "var(--c-field-deep)" },
  pass: { c: "var(--s-active)", on: "var(--c-field-deep)" },
  pending: { c: "var(--s-paused)", on: "var(--c-field-deep)" },
  cooldown: { c: "var(--s-paused)", on: "var(--c-field-deep)" },
  fail: { c: "var(--s-failed)", on: "var(--c-paper)" },
  no_match: { c: "var(--c-ink-soft)", on: "var(--c-paper)" },
  self_comment: { c: "var(--c-ink-soft)", on: "var(--c-paper)" },
  spam_guard: { c: "var(--c-ink-soft)", on: "var(--c-paper)" },
  duplicate: { c: "var(--c-ink-soft)", on: "var(--c-paper)" },
  disabled: { c: "var(--c-ink-soft)", on: "var(--c-paper)" },
  skipped: { c: "var(--c-ink-soft)", on: "var(--c-paper)" },
  not_applicable: { c: "var(--c-ink-soft)", on: "var(--c-paper)" },
};

export function StatusPill({ state, label }: { state: string; label?: string }) {
  const t = TONE[state] ?? TONE.draft;
  return (
    <span
      className="util inline-flex items-center gap-1.5 px-2 py-1 rounded-jack whitespace-nowrap"
      style={{ background: t.c, color: t.on }}
    >
      <span
        aria-hidden
        className="w-1.5 h-1.5 rounded-jack"
        style={{ background: t.on, opacity: 0.7 }}
      />
      {label ?? state.replace("_", " ")}
    </span>
  );
}

/* ── Marginalia: the running index down the left margin.
      Values are real (event counts, queue depth, window clock). ── */
export function Marginalia({ items }: { items: [string, string][] }) {
  return (
    <ul className="util space-y-2 text-paper/55">
      {items.map(([k, v]) => (
        <li key={k} data-arrival="mark" className="flex items-baseline gap-2">
          <span className="text-saffron">{k}</span>
          <span aria-hidden className="flex-1 border-b border-dotted border-line" />
          <span className="text-paper/85">{v}</span>
        </li>
      ))}
    </ul>
  );
}

/* ── Form field: visible label, helper text under, error near the field ── */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="util block text-ink-soft">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[13px] flex items-start gap-1.5" style={{ color: "var(--c-madder)" }}>
          <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-ink-soft">{hint}</p>
      ) : null}
    </div>
  );
}

/* ── Toggle: 44px target, keyboard operable, state named in text ── */
export function Toggle({
  id,
  checked,
  onLabel = "Yoqilgan",
  offLabel = "O'chirilgan",
  onClick,
  disabled = false,
}: {
  id: string;
  checked?: boolean;
  onLabel?: string;
  offLabel?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={!!checked}
        disabled={disabled}
        onClick={onClick}
        className="relative w-[52px] h-[30px] rounded-jack border transition-colors duration-200 disabled:opacity-50"
        style={{
          background: checked ? "var(--c-signal)" : "rgba(12,13,63,.5)",
          borderColor: "var(--c-line)",
        }}
      >
        <span
          className="absolute top-[3px] w-[22px] h-[22px] rounded-jack transition-transform duration-200"
          style={{
            left: 3,
            background: checked ? "var(--c-field-deep)" : "var(--c-paper)",
            transform: checked ? "translateX(22px)" : "none",
          }}
        />
      </button>
      <span className="util text-ink-soft">{checked ? onLabel : offLabel}</span>
    </span>
  );
}

/* ── Empty state: an invitation, not a shrug ── */
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-center py-12 px-6">
      <p className="font-display text-d-1 mb-2">{title}</p>
      <p className="text-b-0 text-ink-soft measure mx-auto mb-5">{body}</p>
      {action}
    </div>
  );
}
