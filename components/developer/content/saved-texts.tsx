"use client";

/**
 * Shablonlar (spec §10.5): hashtag groups, signatures and caption
 * templates, grouped by tag; the composer inserts them with one click.
 */

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Field, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { CONTENT_API, countCaption, jsonInit, requestJson, type ContentMeta, type SavedText } from "./shared";

const EMPTY = { title: "", body: "", tags: "hashtags" };

export default function SavedTexts({ meta, onChanged }: { meta: ContentMeta; onChanged: () => void }) {
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = new Map<string, SavedText[]>();
  for (const t of meta.savedTexts) {
    const key = t.tags[0] ?? "boshqa";
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const body = { title: form.title.trim(), body: form.body, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) };
    const res = editing ? await requestJson(`${CONTENT_API}/saved-texts/${editing}`, jsonInit("PATCH", body)) : await requestJson(`${CONTENT_API}/saved-texts`, jsonInit("POST", body));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setForm(EMPTY);
    setEditing(null);
    onChanged();
  }

  async function remove(id: string) {
    const res = await requestJson(`${CONTENT_API}/saved-texts/${id}`, { method: "DELETE" });
    if (!res.ok) setError(res.error);
    else onChanged();
  }

  const counts = countCaption(form.body);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
      {meta.me.canCreate && (
        <div className="space-y-3 rounded-2xl border border-border bg-surface p-4">
          <h3 className="font-semibold">{editing ? "Shablonni tahrirlash" : "Yangi shablon"}</h3>
          <Field label="Sarlavha" hint="32 belgigacha">
            <input className={inputClass} value={form.title} maxLength={32} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Matn" hint={`${counts.chars} belgi · ${counts.hashtags} hashtag · ${counts.mentions} @`}>
            <textarea className={`${inputClass} min-h-32`} value={form.body} maxLength={16_192} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </Field>
          <Field label="Teg" hint="hashtags, imzo, shablon…">
            <input className={inputClass} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex gap-2">
            <button type="button" className={primaryButton} disabled={busy || !form.title.trim() || !form.body.trim()} onClick={() => void save()}>
              Saqlash
            </button>
            {editing && (
              <button
                type="button"
                className={secondaryButton}
                onClick={() => {
                  setEditing(null);
                  setForm(EMPTY);
                }}
              >
                Bekor
              </button>
            )}
          </div>
        </div>
      )}
      <div className="space-y-4">
        {groups.size === 0 && <p className="text-sm text-muted">Hali shablon yo&apos;q. Hashtag guruhini saqlang — composer&apos;da bir bosishda qo&apos;shiladi.</p>}
        {[...groups.entries()].map(([tag, list]) => (
          <section key={tag}>
            <h4 className="label-mono mb-2 text-[11px] font-semibold text-muted">#{tag}</h4>
            <ul className="space-y-2">
              {list.map((t) => (
                <li key={t.id} className="rounded-2xl border border-border bg-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold">{t.title}</span>
                    {meta.me.canCreate && (
                      <span className="flex gap-1">
                        <button
                          type="button"
                          className={`${secondaryButton} !py-0.5 text-xs`}
                          onClick={() => {
                            setEditing(t.id);
                            setForm({ title: t.title, body: t.body, tags: t.tags.join(", ") });
                          }}
                        >
                          Tahrirlash
                        </button>
                        <button type="button" className={`${secondaryButton} !py-0.5 text-xs`} onClick={() => void remove(t.id)}>
                          O&apos;chirish
                        </button>
                      </span>
                    )}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted">{t.body.length > 300 ? `${t.body.slice(0, 300)}…` : t.body}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
