"use client";

/**
 * Follow-up steps (max 5). Delays count from the button tap (comments) or
 * from the reply (DM triggers) and must stay inside Meta's 24-hour window,
 * so the editor caps them at 23 hours. DM triggers send no button, so they
 * pass a narrower list of conditions.
 */

import {
  COMMENT_LIMITS as L,
  FOLLOW_UP_CONDITIONS,
  type FollowUpCondition,
} from "@/lib/triggers/comment-limits";
import { inputClass, secondaryButton } from "@/components/developer/ui";
import { CharCount } from "./parts";
import { FOLLOW_UP_CONDITION_TEXT, formatDelay, uid } from "./shared";

export interface FollowUpItem {
  key: string;
  id?: string;
  delayMinutes: number;
  condition: FollowUpCondition;
  message: string;
}

export default function FollowUpsEditor({
  items,
  onChange,
  conditions = FOLLOW_UP_CONDITIONS,
  delayLabel = "Tugma bosilgandan keyin (daqiqa)",
}: {
  items: FollowUpItem[];
  onChange: (items: FollowUpItem[]) => void;
  /** Conditions offered in the picker. */
  conditions?: readonly FollowUpCondition[];
  /** What the delay counts from. */
  delayLabel?: string;
}) {
  const update = (key: string, patch: Partial<FollowUpItem>) =>
    onChange(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  function add() {
    const last = items[items.length - 1]?.delayMinutes ?? 0;
    onChange([
      ...items,
      {
        key: uid(),
        delayMinutes: Math.min(L.followUpMaxDelayMinutes, last ? last + 120 : 60),
        condition: "NO_REPLY",
        message: "",
      },
    ]);
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => {
        const previous = items[index - 1]?.delayMinutes ?? 0;
        const outOfOrder = index > 0 && item.delayMinutes <= previous;
        const tooLate = item.delayMinutes > L.followUpMaxDelayMinutes;
        return (
          <div key={item.key} className="space-y-2 rounded-lg border border-border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">{index + 1}-follow-up</span>
              <button
                type="button"
                className="text-xs text-muted hover:text-error"
                aria-label={`${index + 1}-follow-upni o'chirish`}
                onClick={() => onChange(items.filter((s) => s.key !== item.key))}
              >
                O&apos;chirish
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 text-xs text-muted">
                <span>{delayLabel}</span>
                <input
                  type="number"
                  min={1}
                  max={L.followUpMaxDelayMinutes}
                  className={inputClass}
                  value={item.delayMinutes}
                  onChange={(e) => update(item.key, { delayMinutes: Math.round(Number(e.target.value) || 0) })}
                />
                <span className={outOfOrder || tooLate ? "text-error" : ""}>
                  {tooLate
                    ? `Ko'pi bilan ${L.followUpMaxDelayMinutes} daqiqa (23 soat)`
                    : outOfOrder
                      ? "Oldingi follow-updan keyinroq bo'lsin"
                      : `= ${formatDelay(item.delayMinutes)}`}
                </span>
              </label>
              <label className="space-y-1 text-xs text-muted">
                <span>Shart</span>
                <select
                  className={inputClass}
                  value={item.condition}
                  onChange={(e) => update(item.key, { condition: e.target.value as FollowUpCondition })}
                >
                  {conditions.map((condition) => (
                    <option key={condition} value={condition}>
                      {FOLLOW_UP_CONDITION_TEXT[condition]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <textarea
              className={`${inputClass} min-h-16`}
              value={item.message}
              maxLength={L.messageLength}
              aria-label={`${index + 1}-follow-up matni`}
              placeholder="Katalogni ko'rib chiqdingizmi? Savollaringiz bo'lsa yozing 🙂"
              onChange={(e) => update(item.key, { message: e.target.value })}
            />
            <CharCount value={item.message} max={L.messageLength} />
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={secondaryButton} disabled={items.length >= L.followUpSteps} onClick={add}>
          + Follow-up
        </button>
        <span className="text-xs text-muted">
          {items.length}/{L.followUpSteps}
        </span>
      </div>
    </div>
  );
}
