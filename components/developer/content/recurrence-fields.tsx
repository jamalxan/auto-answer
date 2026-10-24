"use client";

/**
 * "Takrorlash" (FR-S8) in the composer: off by default; frequency, weekdays,
 * end date and the live number of copies — computed with the same pure
 * expansion the server schedules with (lib/content/recurrence).
 */

import { Field, inputClass, secondaryButton, Toggle } from "@/components/developer/ui";
import { expandRecurrence, RECURRENCE_LIMITS, type RecurrenceFrequency } from "@/lib/content/recurrence";
import { WEEKDAYS } from "./shared";

export interface RecurState {
  on: boolean;
  frequency: RecurrenceFrequency;
  interval: number;
  weekdays: number[];
  until: string;
}

export function emptyRecur(startDate: string): RecurState {
  const until = new Date(Date.parse(`${/^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
  return { on: false, frequency: "weekly", interval: 1, weekdays: [], until };
}

/** The `recur` action body for a start date and time. */
export function recurBody(r: RecurState, startDate: string, time: string) {
  return { frequency: r.frequency, interval: r.interval, weekdays: r.frequency === "weekly" ? r.weekdays : undefined, startDate, time, until: r.until };
}

export function recurPreview(r: RecurState, startDate: string, time: string, timezone: string): { count: number; error: string | null } {
  if (!r.on) return { count: 0, error: null };
  const res = expandRecurrence({ ...recurBody(r, startDate, time), timezone });
  return res.ok ? { count: res.dates.length, error: null } : { count: 0, error: res.error };
}

const FREQUENCIES: Array<[RecurrenceFrequency, string]> = [
  ["daily", "Har kuni"],
  ["weekly", "Hafta kunlari"],
  ["monthly", "Har oy"],
];

export default function RecurrenceFields({ value, onChange, startDate, time, timezone }: { value: RecurState; onChange: (next: RecurState) => void; startDate: string; time: string; timezone: string }) {
  const preview = recurPreview(value, startDate, time, timezone);
  const set = (patch: Partial<RecurState>) => onChange({ ...value, ...patch });
  const unit = value.frequency === "daily" ? "kunda" : value.frequency === "weekly" ? "haftada" : "oyda";

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-foreground">
          Takrorlash
          <p className="text-xs text-muted">Har bir nusxa alohida post bo&apos;lib rejalashtiriladi (ko&apos;pi bilan {RECURRENCE_LIMITS.maxSpanDays} kun, {RECURRENCE_LIMITS.maxCopies} ta nusxa).</p>
        </div>
        <Toggle on={value.on} onChange={(on) => set({ on })} label="Takrorlash" />
      </div>
      {value.on && (
        <>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Takrorlash turi">
            {FREQUENCIES.map(([f, label]) => (
              <button key={f} type="button" role="radio" aria-checked={value.frequency === f} onClick={() => set({ frequency: f })} className={`${secondaryButton} ${value.frequency === f ? "border-accent/60 text-foreground" : ""}`}>
                {label}
              </button>
            ))}
          </div>
          {value.frequency === "weekly" && (
            <div className="flex flex-wrap gap-1" aria-label="Hafta kunlari">
              {WEEKDAYS.map((label, i) => {
                const on = value.weekdays.includes(i);
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set({ weekdays: on ? value.weekdays.filter((d) => d !== i) : [...value.weekdays, i].sort() })}
                    className={`${secondaryButton} !px-2.5 !py-1 text-xs ${on ? "border-accent/60 bg-accent/15 text-foreground" : ""}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <Field label={`Har nechta ${unit}`}>
              <input type="number" min={1} max={RECURRENCE_LIMITS.maxInterval} className={`${inputClass} !w-20`} value={value.interval} onChange={(e) => set({ interval: Math.min(RECURRENCE_LIMITS.maxInterval, Math.max(1, Number(e.target.value) || 1)) })} />
            </Field>
            <Field label="Tugash sanasi">
              <input type="date" className={`${inputClass} !w-auto`} value={value.until} min={startDate} onChange={(e) => set({ until: e.target.value })} />
            </Field>
          </div>
          {value.frequency === "monthly" && <p className="text-xs text-muted">Oyning shu kuni bo&apos;lmagan oylar (masalan, 31-sana) o&apos;tkazib yuboriladi.</p>}
          {preview.error ? <p className="text-xs text-error">{preview.error}</p> : <p className="text-xs text-foreground">{preview.count} ta nusxa rejalashtiriladi (birinchisi — shu post).</p>}
        </>
      )}
    </div>
  );
}
