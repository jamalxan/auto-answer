/** Number formatting and the range picker shared by the overview views. */

import type { Metrics } from "@/lib/analytics/network-stats";

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("uz-UZ");
}

/** Likes + comments + shares; null when the platform gave none of them. */
export function engagement(m: Metrics | null): number | null {
  if (!m) return null;
  const parts = [m.likes, m.comments, m.shares].filter((v): v is number => v !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

const WHEN = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "05.11 20:25" in Tashkent time (the uz-UZ locale prints month first). */
export function formatWhen(iso: string): string {
  const parts = Object.fromEntries(WHEN.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day}.${parts.month} ${parts.hour}:${parts.minute}`;
}

export function RangePicker({ value, onChange }: { value: Range; onChange: (d: Range) => void }) {
  return (
    <div className="inline-flex rounded-full bg-surface p-1" role="group" aria-label="Davr">
      {RANGES.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={value === d}
          onClick={() => d !== value && onChange(d)}
          className={`rounded-full px-3.5 py-1.5 text-sm font-semibold tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-lime ${
            value === d ? "bg-violet text-white" : "text-muted hover:text-white"
          }`}
        >
          {d} kun
        </button>
      ))}
    </div>
  );
}
