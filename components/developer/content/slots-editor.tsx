"use client";

/**
 * Navbat slotlari (FR-S9): the weekly times of one account, edited as a list
 * per weekday (add a time, remove a time, optionally only for one post type).
 * "Saqlash" replaces the whole set (PUT accounts/[id]/slots). Times are in
 * the workspace zone.
 */

import { useEffect, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Field, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { CONTENT_API, jsonInit, requestJson, TYPE_LABEL, WEEKDAYS, type ContentMeta, type PostTypeValue } from "./shared";

interface Slot {
  weekday: number;
  minuteOfDay: number;
  postType: PostTypeValue | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const label = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const SLOT_TYPES: PostTypeValue[] = ["FEED_IMAGE", "CAROUSEL", "REEL", "STORY"];

export default function SlotsEditor({ meta, accountId, onClose }: { meta: ContentMeta; accountId?: string; onClose: () => void }) {
  const [account, setAccount] = useState(accountId || meta.accounts[0]?.id || "");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [weekday, setWeekday] = useState(0);
  const [time, setTime] = useState("19:00");
  const [type, setType] = useState<PostTypeValue | "">("");
  const canEdit = meta.me.canSchedule;

  useEffect(() => {
    if (!account) return;
    let alive = true;
    /* eslint-disable react-hooks/set-state-in-effect -- data fetch on account change */
    setLoading(true);
    setSaved(false);
    setDirty(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    void requestJson<{ slots: Slot[] }>(`${CONTENT_API}/accounts/${account}/slots`).then((res) => {
      if (!alive) return;
      setLoading(false);
      if (res.ok) {
        setSlots(res.data.slots.map((s) => ({ weekday: s.weekday, minuteOfDay: s.minuteOfDay, postType: s.postType ?? null })));
        setError(null);
      } else setError(res.error);
    });
    return () => {
      alive = false;
    };
  }, [account]);

  function add() {
    const m = /^(\d{2}):(\d{2})$/.exec(time);
    if (!m) return setError("Vaqtni HH:mm ko'rinishida kiriting");
    const minuteOfDay = Number(m[1]) * 60 + Number(m[2]);
    const next = slots.filter((s) => !(s.weekday === weekday && s.minuteOfDay === minuteOfDay));
    next.push({ weekday, minuteOfDay, postType: type || null });
    next.sort((a, b) => a.weekday - b.weekday || a.minuteOfDay - b.minuteOfDay);
    setSlots(next);
    setDirty(true);
    setSaved(false);
    setError(null);
  }

  function remove(slot: Slot) {
    setSlots((list) => list.filter((s) => s !== slot));
    setDirty(true);
    setSaved(false);
  }

  /** "Hamma kunga": the same time on all seven days. */
  function addEveryDay() {
    const m = /^(\d{2}):(\d{2})$/.exec(time);
    if (!m) return setError("Vaqtni HH:mm ko'rinishida kiriting");
    const minuteOfDay = Number(m[1]) * 60 + Number(m[2]);
    const next = slots.filter((s) => s.minuteOfDay !== minuteOfDay);
    for (let d = 0; d < 7; d++) next.push({ weekday: d, minuteOfDay, postType: type || null });
    next.sort((a, b) => a.weekday - b.weekday || a.minuteOfDay - b.minuteOfDay);
    setSlots(next);
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await requestJson<{ slots: Slot[] }>(`${CONTENT_API}/accounts/${account}/slots`, jsonInit("PUT", { slots }));
    setSaving(false);
    if (!res.ok) return setError(res.error);
    setSlots(res.data.slots.map((s) => ({ weekday: s.weekday, minuteOfDay: s.minuteOfDay, postType: s.postType ?? null })));
    setDirty(false);
    setSaved(true);
  }

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-surface p-4" aria-label="Navbat slotlari">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Navbat slotlari</h3>
          <p className="text-xs text-muted">«Navbatga qo&apos;shish» postni shu vaqtlardan eng yaqin bo&apos;shiga qo&apos;yadi · {meta.timezone}</p>
        </div>
        <div className="flex items-center gap-2">
          <select className={`${inputClass} !w-auto`} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Akkaunt">
            {meta.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username}
              </option>
            ))}
          </select>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Yopish
          </button>
        </div>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice tone="info">Slotlar saqlandi.</Notice>}

      {loading ? (
        <p className="text-xs text-muted">Yuklanmoqda…</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-7">
          {WEEKDAYS.map((name, d) => {
            const list = slots.filter((s) => s.weekday === d);
            return (
              <div key={name} className="min-h-20 rounded-lg border border-border p-2">
                <div className="label-mono mb-1 text-[11px] font-semibold text-muted">{name}</div>
                {list.length === 0 && <p className="text-[11px] text-muted">—</p>}
                <ul className="flex flex-wrap gap-1 sm:flex-col">
                  {list.map((s) => (
                    <li key={`${s.weekday}-${s.minuteOfDay}`} className="flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-xs">
                      <span className="font-semibold">{label(s.minuteOfDay)}</span>
                      {s.postType && <span className="text-[10px] text-muted">{TYPE_LABEL[s.postType]}</span>}
                      {canEdit && (
                        <button type="button" className="ml-auto text-muted hover:text-error" aria-label={`${name} ${label(s.minuteOfDay)} slotini olib tashlash`} onClick={() => remove(s)}>
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {canEdit ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <Field label="Kun">
            <select className={`${inputClass} !w-auto`} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
              {WEEKDAYS.map((name, d) => (
                <option key={name} value={d}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Vaqt">
            <input type="time" className={`${inputClass} !w-auto`} value={time} step={300} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <Field label="Tur">
            <select className={`${inputClass} !w-auto`} value={type} onChange={(e) => setType(e.target.value as PostTypeValue | "")}>
              <option value="">Istalgan</option>
              {SLOT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className={secondaryButton} onClick={add}>
            Qo&apos;shish
          </button>
          <button type="button" className={secondaryButton} onClick={addEveryDay}>
            Hamma kunga
          </button>
          <button type="button" className={`${primaryButton} ml-auto`} disabled={saving || !dirty || !account} onClick={() => void save()}>
            {saving ? "Saqlanmoqda…" : "Saqlash"}
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted">Slotlarni MANAGER va undan yuqori rol o&apos;zgartiradi.</p>
      )}
    </section>
  );
}
