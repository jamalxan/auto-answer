"use client";

/**
 * Event checkboxes + the shared filter (temperature, minimum score, accounts,
 * channels, tags, test / transcript flags) used by every create form and by
 * the "Obunalar" editor of a card. One filter applies to all chosen events.
 */

import { useId } from "react";
import { ChipInput, Field, inputClass } from "@/components/developer/ui";
import { CHANNELS, TEMPERATURE_LABEL, type Account, type EventType, type SubscriptionFilter, type Temperature } from "./shared";

export interface SubscriptionDraft {
  events: EventType[];
  filter: SubscriptionFilter;
}

export const EMPTY_FILTER: SubscriptionFilter = { v: 1 };

/** Drops empty lists so the stored filter stays minimal. */
export function cleanFilter(filter: SubscriptionFilter): SubscriptionFilter {
  const out: SubscriptionFilter = { v: 1 };
  if (filter.temperatures?.length) out.temperatures = filter.temperatures;
  if (filter.min_score !== undefined && Number.isFinite(filter.min_score)) out.min_score = filter.min_score;
  if (filter.accounts?.length) out.accounts = filter.accounts;
  if (filter.channels?.length) out.channels = filter.channels;
  if (filter.tags?.length) out.tags = filter.tags;
  if (filter.stages?.length) out.stages = filter.stages;
  if (filter.include_test) out.include_test = true;
  if (filter.include_transcript) out.include_transcript = true;
  return out;
}

function toggle<T>(list: T[] | undefined, value: T): T[] {
  const current = list ?? [];
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint?: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
      <input id={id} type="checkbox" checked={checked} onChange={onChange} className="mt-1 h-4 w-4 accent-accent" />
      <span className="min-w-0">
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export default function SubscriptionEditor({
  draft,
  onChange,
  events,
  accounts,
  disabled,
  hideFilter,
}: {
  draft: SubscriptionDraft;
  onChange: (next: SubscriptionDraft) => void;
  events: Array<{ type: EventType; label: string; description: string }>;
  accounts: Account[];
  disabled?: boolean;
  hideFilter?: boolean;
}) {
  const { filter } = draft;
  const setFilter = (patch: Partial<SubscriptionFilter>) => onChange({ ...draft, filter: { ...filter, ...patch } });

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="label-mono mb-1 text-[11px] font-semibold text-muted">Hodisalar</legend>
        {events.map((event) => (
          <Check
            key={event.type}
            checked={draft.events.includes(event.type)}
            onChange={() => onChange({ ...draft, events: toggle(draft.events, event.type) })}
            label={`${event.label} · ${event.type}`}
            hint={event.description}
          />
        ))}
      </fieldset>

      {!hideFilter && (
        <fieldset className="space-y-3 rounded-lg border border-dashed border-border p-3" disabled={disabled}>
          <legend className="label-mono px-1 text-[11px] font-semibold text-muted">Filtr (bo&apos;sh = hammasi)</legend>
          <Field label="Harorat" hint="Faqat shu haroratdagi leadlar. Bo'sh bo'lsa — hammasi.">
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {(["COLD", "WARM", "HOT", "CUSTOMER", "LOST"] as Temperature[]).map((t) => (
                <Check
                  key={t}
                  checked={Boolean(filter.temperatures?.includes(t))}
                  onChange={() => setFilter({ temperatures: toggle(filter.temperatures, t) })}
                  label={TEMPERATURE_LABEL[t]}
                />
              ))}
            </div>
          </Field>
          <Field label="Minimal ball (0–100)">
            <input
              type="number"
              min={0}
              max={100}
              inputMode="numeric"
              className={inputClass}
              value={filter.min_score ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                setFilter({ min_score: raw === "" ? undefined : Math.max(0, Math.min(100, Math.round(Number(raw)))) });
              }}
              placeholder="masalan, 60"
            />
          </Field>
          {accounts.length > 1 && (
            <Field label="Instagram akkaunt">
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {accounts.map((a) => (
                  <Check key={a.id} checked={Boolean(filter.accounts?.includes(a.id))} onChange={() => setFilter({ accounts: toggle(filter.accounts, a.id) })} label={`@${a.username}`} />
                ))}
              </div>
            </Field>
          )}
          <Field label="Kanal">
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {CHANNELS.map(([key, label]) => (
                <Check key={key} checked={Boolean(filter.channels?.includes(key))} onChange={() => setFilter({ channels: toggle(filter.channels, key) })} label={label} />
              ))}
            </div>
          </Field>
          <Field label="Teglar" hint="Kontaktda shu teglardan biri bo'lsa (slug).">
            <ChipInput values={filter.tags ?? []} onChange={(tags) => setFilter({ tags })} placeholder="vip, ielts…" max={20} />
          </Field>
          <div className="space-y-2">
            <Check
              checked={Boolean(filter.include_test)}
              onChange={() => setFilter({ include_test: !filter.include_test })}
              label="Test hodisalar ham"
              hint="«Sinash» tugmasi va test leadlar faqat shu yoqilganda keladi."
            />
            <Check
              checked={Boolean(filter.include_transcript)}
              onChange={() => setFilter({ include_transcript: !filter.include_transcript })}
              label="Suhbat matni ham"
              hint="Payload'ga to'liq transcript qo'shiladi (shaxsiy ma'lumot)."
            />
          </div>
        </fieldset>
      )}
    </div>
  );
}
