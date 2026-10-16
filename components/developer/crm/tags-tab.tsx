"use client";

/**
 * Taglar (TZ 28): the workspace tag list with contact counts, create /
 * rename / recolour / delete. Manual, AI and automation tags share the list;
 * the origin is visible per contact in the drawer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Field, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import { CRM_API, jsonInit, requestJson, type Meta, type TagRow } from "./shared";

const PALETTE = ["#EF4444", "#F97316", "#F59E0B", "#22C55E", "#06B6D4", "#3B82F6", "#8B5CF6", "#EC4899", "#64748B"];

export function TagChip({ tag, onRemove }: { tag: { name: string; color: string | null }; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-foreground ring-1 ring-inset ring-current/20"
      style={{ background: `${tag.color ?? "#64748B"}22`, color: tag.color ?? undefined }}
    >
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="opacity-70 hover:opacity-100" aria-label={`${tag.name} tegini olib tashlash`}>
          ×
        </button>
      )}
    </span>
  );
}

function ColorPicker({ value, onChange }: { value: string | null; onChange: (color: string | null) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Rang">
      {PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          onClick={() => onChange(color)}
          className={`h-6 w-6 rounded-full ring-2 ring-offset-2 ring-offset-background ${value === color ? "ring-foreground" : "ring-transparent"}`}
          style={{ background: color }}
        />
      ))}
    </div>
  );
}

function TagEditor({ tag, onDone, onCancel }: { tag: TagRow | null; onDone: () => void; onCancel?: () => void }) {
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState<string | null>(tag?.color ?? PALETTE[5]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = tag
        ? await requestJson(`${CRM_API}/tags/${tag.id}`, jsonInit("PATCH", { name, color }))
        : await requestJson(`${CRM_API}/tags`, jsonInit("POST", { name, color }));
      if (res.ok) {
        setName("");
        onDone();
      } else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <p className="text-sm font-semibold text-foreground">{tag ? "Tegni tahrirlash" : "Yangi teg"}</p>
      <Field label="Nomi" hint={`40 belgigacha; slug avtomatik: "TO'LOV KUTILMOQDA" → tolov-kutilmoqda`}>
        <input className={inputClass} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="VIP, IELTS, Toshkent…" />
      </Field>
      <Field label="Rang">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? "Saqlanmoqda…" : tag ? "Saqlash" : "Teg qo'shish"}
        </button>
        {onCancel && (
          <button type="button" className={secondaryButton} onClick={onCancel}>
            Bekor
          </button>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

export default function TagsTab({ meta, onChanged }: { meta: Meta; onChanged: () => void }) {
  const [tags, setTags] = useState<TagRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<{ tags: TagRow[] }>(`${CRM_API}/tags`);
    if (mine !== seq.current) return;
    if (res.ok) setTags(res.data.tags);
    else setError(res.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  async function remove(id: string) {
    const res = await requestJson(`${CRM_API}/tags/${id}`, { method: "DELETE" });
    if (!res.ok) setError(res.error);
    void load();
    onChanged();
  }

  const canManage = meta.me.canManage;

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      <section className="panel space-y-3 rounded-xl p-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Taglar</h2>
          <p className="mt-1 text-xs text-muted">
            Qo&apos;lda, JavobAI (harorat, mahsulot, joy) va avtomatlashtirish (kampaniya, havola) qo&apos;yadigan taglar bitta ro&apos;yxatda.
            Tegni o&apos;chirish uni barcha kontaktlardan olib tashlaydi.
          </p>
        </div>
        {tags === null ? (
          <p className="py-6 text-center text-sm text-muted">Yuklanmoqda…</p>
        ) : tags.length === 0 ? (
          <EmptyState title="Hali teg yo'q" body="Birinchi CRM tashrifida standart taglar (HOT, VIP, YANGI…) yaratiladi." />
        ) : (
          <ul className="divide-y divide-border">
            {tags.map((tag) => (
              <li key={tag.id} className="py-2">
                {editing === tag.id ? (
                  <TagEditor
                    tag={tag}
                    onDone={() => {
                      setEditing(null);
                      void load();
                      onChanged();
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <TagChip tag={tag} />
                      <span className="label-mono text-[11px] text-muted">{tag.slug}</span>
                      <span className="text-xs text-muted">{tag.contactCount} ta kontakt</span>
                    </div>
                    {canManage && (
                      <div className="flex items-center gap-2">
                        <button type="button" className={secondaryButton} onClick={() => setEditing(tag.id)}>
                          Tahrirlash
                        </button>
                        <ConfirmButton
                          label="O'chirish"
                          question={`"${tag.name}" ${tag.contactCount} ta kontaktdan olib tashlanadi. O'chirilsinmi?`}
                          confirmLabel="O'chirish"
                          danger
                          onConfirm={() => void remove(tag.id)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && tags !== null && (
          <TagEditor
            tag={null}
            onDone={() => {
              void load();
              onChanged();
            }}
          />
        )}
      </section>
    </div>
  );
}
