import type { ReactNode } from "react";

/* ── Placeholder substitution, same rules as the backend renderer ── */
export function render(
  body: string,
  vars: { username?: string; first_name?: string; link?: string; keyword?: string }
) {
  return body.replace(/\{(username|first_name|link|keyword)\}/g, (_, k) =>
    (vars as Record<string, string | undefined>)[k] ?? `{${k}}`
  );
}

export type Step = {
  step: "public_reply" | "opening" | "gate" | "reward" | "retry" | "decline";
  body: string;
  quick_replies?: { label: string; payload: string }[];
};

const STEP_LABEL: Record<Step["step"], string> = {
  public_reply: "Ochiq javob",
  opening: "1-xabar",
  gate: "Shart",
  reward: "Havola",
  retry: "Qayta urinish",
  decline: "Rad javobi",
};

/**
 * ChatPreview — exactly what the person on Instagram will receive.
 * Used in the campaign editor (FR-8.1) and inside the pinned act on the
 * landing page, so the marketing claim and the product are the same object.
 */
export function ChatPreview({
  steps,
  username = "dilnoza_s",
  link = "https://kurs.uz/reels-funnel",
  keyword = "tizim",
  compact = false,
}: {
  steps: Step[];
  username?: string;
  link?: string;
  keyword?: string;
  compact?: boolean;
}) {
  return (
    <div
      className="rounded-bay overflow-hidden"
      style={{ background: "var(--c-field-deep)", border: "1px solid var(--c-line)" }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 border-b"
        style={{ borderColor: "var(--c-line)" }}
      >
        <span
          className="w-6 h-6 rounded-jack shrink-0"
          style={{ background: "var(--c-madder)" }}
          aria-hidden
        />
        <span className="util text-paper/70">@{username}</span>
        <span className="util ml-auto" style={{ color: "var(--c-wrong)" }}>
          Direct
        </span>
      </div>

      <ol className={`space-y-2.5 ${compact ? "p-3" : "p-4"}`}>
        {steps.map((s, i) => (
          <li key={i} className="space-y-1.5">
            <p className="util text-saffron/80">{STEP_LABEL[s.step]}</p>
            <div
              className="max-w-[86%] px-3 py-2 text-[15px] leading-snug rounded-bay"
              style={{
                background:
                  s.step === "reward" ? "var(--c-signal)" : "var(--c-field-lift)",
                color: s.step === "reward" ? "var(--c-field-deep)" : "var(--c-paper)",
              }}
            >
              {render(s.body, { username, link, keyword })}
            </div>
            {!!s.quick_replies?.length && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {s.quick_replies.map((q) => (
                  <span
                    key={q.payload}
                    className="util px-2.5 py-1.5 rounded-jack border"
                    style={{ borderColor: "var(--c-signal)", color: "var(--c-signal)" }}
                  >
                    {q.label}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ── Table: dense data on paper, sticky head, real column labels ── */
export function Table({
  head,
  children,
}: {
  head: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto -mx-4">
      <table className="w-full min-w-[720px] border-collapse text-[15px]">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="util text-left font-normal text-ink-soft px-4 py-2 border-b"
                style={{ borderColor: "rgba(22,22,46,.2)" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  mono = false,
  className = "",
}: {
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`px-4 py-3 align-middle border-b ${
        mono ? "font-util text-[13px]" : ""
      } ${className}`}
      style={{ borderColor: "rgba(22,22,46,.12)" }}
    >
      {children}
    </td>
  );
}

/* ── Sparkline: 7-day trigger count. Data, not decoration. ── */
export function Spark({ points, color = "var(--c-signal)" }: { points: number[]; color?: string }) {
  const max = Math.max(...points, 1);
  const d = points
    .map((p, i) => `${(i / (points.length - 1)) * 100},${28 - (p / max) * 26}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="w-full h-8" role="img"
      aria-label={`Oxirgi ${points.length} kun: ${points.join(", ")}`}>
      <polyline points={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
