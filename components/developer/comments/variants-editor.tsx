"use client";

/**
 * One list of reply variants (DM or public). Manual text counts as approved;
 * AI text shows "Tasdiqlanmagan" until someone approves it, and the engine
 * never sends an unapproved variant.
 */

import { useState } from "react";
import { COMMENT_LIMITS as L, type ReplyMode } from "@/lib/triggers/comment-limits";
import { inputClass, Pill, secondaryButton } from "@/components/developer/ui";
import AiVariantsPanel from "./ai-variants-panel";
import { CharCount, Notice } from "./parts";
import { uid } from "./shared";

export interface VariantItem {
  key: string;
  id?: string;
  kind: "DM" | "PUBLIC";
  text: string;
  weight: number;
  source: "MANUAL" | "AI";
  approved: boolean;
  /** Text as stored; lets "Tasdiqlash" go straight to the API when nothing else changed. */
  savedText?: string;
}

export default function VariantsEditor({
  kind,
  items,
  onChange,
  replyMode,
  defaultGoal,
  keywordsContext,
  onApproveSaved,
  maxLength,
}: {
  kind: "DM" | "PUBLIC";
  items: VariantItem[];
  onChange: (items: VariantItem[]) => void;
  replyMode: ReplyMode;
  defaultGoal: string;
  keywordsContext: string;
  /** Approves a stored, unedited variant right away. Resolves to an error text or null. */
  onApproveSaved: (item: VariantItem) => Promise<string | null>;
  /** Overrides the per-kind limit (DM with the opening button: Meta's 640). */
  maxLength?: number;
}) {
  const [aiOpen, setAiOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const max = maxLength ?? (kind === "DM" ? L.messageLength : L.publicReplyLength);
  const remaining = L.variantsPerKind - items.length;
  const approvedCount = items.filter((v) => v.approved).length;
  const pending = items.filter((v) => !v.approved).length;

  const update = (key: string, patch: Partial<VariantItem>) =>
    onChange(items.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  function addBlank() {
    onChange([...items, { key: uid(), kind, text: "", weight: 1, source: "MANUAL", approved: true }]);
  }

  function addDrafts(texts: string[], approved: boolean) {
    onChange([
      ...items,
      ...texts.map((text) => ({ key: uid(), kind, text, weight: 1, source: "AI" as const, approved })),
    ]);
  }

  async function approve(item: VariantItem) {
    setError(null);
    if (item.id && item.savedText === item.text) {
      setBusyKey(item.key);
      try {
        const failed = await onApproveSaved(item);
        if (failed) setError(failed);
        else update(item.key, { approved: true });
      } finally {
        setBusyKey(null);
      }
    } else {
      // Applied with the next save.
      update(item.key, { approved: true });
    }
  }

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
          Hali variant yo&apos;q.{" "}
          {kind === "DM" ? "Variant bo'lmasa, pastdagi zaxira matn yuboriladi." : "Ochiq javob uchun kamida 1 ta variant kerak."}
        </p>
      ) : (
        <ol className="space-y-2">
          {items.map((item, index) => (
            <li key={item.key} className="space-y-2 rounded-lg border border-border p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-semibold text-foreground">{index + 1}-variant</span>
                  {item.source === "AI" && (
                    <span className="label-mono rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold text-accent">AI</span>
                  )}
                  {item.approved ? (
                    item.source === "AI" && <Pill tone="success">Tasdiqlangan</Pill>
                  ) : (
                    <Pill tone="warning">Tasdiqlanmagan</Pill>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!item.approved && (
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={busyKey === item.key || !item.text.trim()}
                      onClick={() => void approve(item)}
                    >
                      {busyKey === item.key ? "Kuting…" : "Tasdiqlash"}
                    </button>
                  )}
                  {item.approved && item.source === "AI" && (
                    <button
                      type="button"
                      className="text-xs text-muted hover:text-foreground"
                      onClick={() => update(item.key, { approved: false })}
                    >
                      Tasdiqni olish
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-xs text-muted hover:text-error"
                    aria-label={`${index + 1}-variantni o'chirish`}
                    onClick={() => onChange(items.filter((v) => v.key !== item.key))}
                  >
                    O&apos;chirish
                  </button>
                </div>
              </div>
              <textarea
                className={`${inputClass} min-h-16`}
                value={item.text}
                aria-label={`${index + 1}-variant matni`}
                onChange={(e) => update(item.key, { text: e.target.value })}
                placeholder={
                  kind === "DM"
                    ? "Salom! 😊 So'ragan ma'lumotingizni yuboraman…"
                    : "Javob Direct'ga yuborildi 📩"
                }
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CharCount value={item.text} max={max} />
                {replyMode === "WEIGHTED" && (
                  <label className="flex items-center gap-2 text-xs text-muted">
                    Vazn
                    <input
                      type="number"
                      min={L.weightMin}
                      max={L.weightMax}
                      value={item.weight}
                      onChange={(e) => update(item.key, { weight: Math.round(Number(e.target.value) || 1) })}
                      className={`${inputClass} w-20 py-1`}
                    />
                  </label>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {items.length > 0 && items.length < L.variantsRecommended && (
        <Notice tone="warning">
          Kamida {L.variantsRecommended} ta variant tavsiya etiladi — bir xil matn ko&apos;p odamga takrorlansa, Instagram uni
          spam deb hisoblashi mumkin.
        </Notice>
      )}
      {pending > 0 && (
        <Notice tone="warning">
          {pending} ta variant tasdiqlanmagan — ular yuborilmaydi. Hozir {approvedCount} ta variant ishlaydi.
        </Notice>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondaryButton} disabled={remaining <= 0} onClick={addBlank}>
          + Variant qo&apos;shish
        </button>
        <button type="button" className={secondaryButton} disabled={remaining <= 0} onClick={() => setAiOpen((v) => !v)} aria-expanded={aiOpen}>
          ✨ AI bilan yaratish
        </button>
        <span className="self-center text-xs text-muted">
          {items.length}/{L.variantsPerKind}
        </span>
      </div>

      {aiOpen && (
        <AiVariantsPanel
          kind={kind}
          remaining={Math.max(0, remaining)}
          defaultGoal={defaultGoal}
          keywordsContext={keywordsContext}
          maxLength={max}
          onAdd={addDrafts}
          onClose={() => setAiOpen(false)}
        />
      )}
    </div>
  );
}
