"use client";

/**
 * TZ 10 — Generate → Preview → Edit → Approve. The panel only produces
 * drafts; the person edits them inline, ticks the ones to keep and adds them
 * to the campaign either approved (they will be sent) or not (badged
 * "Tasdiqlanmagan", never sent until approved).
 */

import { useRef, useState } from "react";
import { COMMENT_LIMITS as L } from "@/lib/triggers/comment-limits";
import { Field, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { CharCount, Notice } from "./parts";
import { jsonInit, requestJson } from "./shared";

interface Draft {
  key: string;
  text: string;
  selected: boolean;
}

const TONES = [
  ["friendly", "Samimiy"],
  ["professional", "Rasmiy"],
  ["playful", "Quvnoq"],
] as const;
const EMOJIS = [
  ["none", "Emojisiz"],
  ["low", "Kam (1 ta)"],
  ["medium", "O'rtacha (1–3)"],
] as const;
const LANGUAGES = [
  ["uz-latn", "O'zbek (lotin)"],
  ["uz-cyrl", "O'zbek (kirill)"],
  ["ru", "Rus"],
] as const;

export default function AiVariantsPanel({
  kind,
  remaining,
  defaultGoal,
  keywordsContext,
  maxLength,
  onAdd,
  onClose,
}: {
  kind: "DM" | "PUBLIC";
  /** Free slots left under the 10-variant cap. */
  remaining: number;
  defaultGoal: string;
  keywordsContext: string;
  /** Overrides the per-kind limit (DM with the opening button: Meta's 640). */
  maxLength?: number;
  onAdd: (texts: string[], approved: boolean) => void;
  onClose: () => void;
}) {
  const [count, setCount] = useState(Math.max(L.aiMinCount, Math.min(5, L.aiMaxCount)));
  const [goal, setGoal] = useState(defaultGoal);
  const [tone, setTone] = useState<(typeof TONES)[number][0]>("friendly");
  const [emojiLevel, setEmojiLevel] = useState<(typeof EMOJIS)[number][0]>("low");
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number][0]>("uz-latn");
  const [brandName, setBrandName] = useState("");
  const [facts, setFacts] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const max = maxLength ?? (kind === "DM" ? L.messageLength : L.publicReplyLength);

  async function generate() {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await requestJson<{ drafts: string[] }>(
        "/api/comments/ai/variants",
        jsonInit("POST", {
          kind,
          count,
          goal,
          tone,
          emojiLevel,
          language,
          brandName: brandName.trim() || null,
          keywordsContext: keywordsContext || null,
          facts: facts.trim() || null,
        })
      );
      if (mine !== seq.current) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDrafts(res.data.drafts.map((text, i) => ({ key: `${mine}-${i}`, text, selected: true })));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  const picked = drafts.filter((d) => d.selected && d.text.trim() && d.text.length <= max);
  const overCap = picked.length > remaining;

  function add(approved: boolean) {
    onAdd(
      picked.slice(0, remaining).map((d) => d.text.trim()),
      approved
    );
    setDrafts([]);
    onClose();
  }

  return (
    <div className="space-y-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">
          AI bilan yaratish · {kind === "DM" ? "DM variantlari" : "ochiq javob variantlari"}
        </p>
        <button type="button" className="text-xs text-muted hover:text-foreground" onClick={onClose}>
          Yopish
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Maqsad" hint="AI nima haqida yozsin: masalan, “narx so'raganlarga katalogni Direct'da yuborish”">
            <textarea
              className={`${inputClass} min-h-16`}
              value={goal}
              maxLength={300}
              onChange={(e) => setGoal(e.target.value)}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field
            label="Tasdiqlangan ma'lumot (ixtiyoriy)"
            hint="AI faqat shu yerdagi faktlardan foydalanadi. Narx yozilmasa, AI narx o'ylab topmaydi."
          >
            <textarea
              className={`${inputClass} min-h-16`}
              value={facts}
              maxLength={800}
              onChange={(e) => setFacts(e.target.value)}
              placeholder="Masalan: Yetkazib berish Toshkent bo'ylab bepul. Katalog Direct'da yuboriladi."
            />
          </Field>
        </div>
        <Field label="Soni">
          <select className={inputClass} value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {Array.from({ length: L.aiMaxCount - L.aiMinCount + 1 }, (_, i) => L.aiMinCount + i).map((n) => (
              <option key={n} value={n}>
                {n} ta
              </option>
            ))}
          </select>
        </Field>
        <Field label="Til">
          <select className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value as typeof language)}>
            {LANGUAGES.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ohang">
          <select className={inputClass} value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
            {TONES.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Emoji">
          <select className={inputClass} value={emojiLevel} onChange={(e) => setEmojiLevel(e.target.value as typeof emojiLevel)}>
            {EMOJIS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Brend nomi (ixtiyoriy)">
            <input className={inputClass} value={brandName} maxLength={80} onChange={(e) => setBrandName(e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} disabled={loading || goal.trim().length < 3} onClick={() => void generate()}>
          {loading ? "Yaratilmoqda…" : drafts.length ? "Qayta yaratish" : "Yaratish"}
        </button>
        <span className="text-xs text-muted">Hech narsa avtomatik saqlanmaydi.</span>
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      {drafts.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted">Ko&apos;rib chiqing, tahrirlang va keraklisini belgilang</p>
          {drafts.map((draft, index) => (
            <div key={draft.key} className="flex gap-2 rounded-lg border border-border bg-surface p-2">
              <input
                type="checkbox"
                className="mt-2 h-4 w-4 shrink-0"
                checked={draft.selected}
                aria-label={`${index + 1}-variantni tanlash`}
                onChange={(e) =>
                  setDrafts((list) => list.map((d) => (d.key === draft.key ? { ...d, selected: e.target.checked } : d)))
                }
              />
              <div className="min-w-0 flex-1 space-y-1">
                <textarea
                  className={`${inputClass} min-h-16`}
                  value={draft.text}
                  aria-label={`${index + 1}-variant matni`}
                  onChange={(e) =>
                    setDrafts((list) => list.map((d) => (d.key === draft.key ? { ...d, text: e.target.value } : d)))
                  }
                />
                <CharCount value={draft.text} max={max} />
              </div>
            </div>
          ))}
          {remaining === 0 ? (
            <Notice tone="warning">Variantlar soni {L.variantsPerKind} taga yetgan — avval bittasini o&apos;chiring.</Notice>
          ) : overCap ? (
            <Notice tone="warning">
              Yana faqat {remaining} ta joy bor ({L.variantsPerKind} tagacha) — tanlanganlardan birinchi {remaining} tasi qo&apos;shiladi.
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryButton}
              disabled={picked.length === 0 || remaining === 0}
              onClick={() => add(true)}
            >
              Tasdiqlab qo&apos;shish ({Math.min(picked.length, remaining)})
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={picked.length === 0 || remaining === 0}
              onClick={() => add(false)}
            >
              Tasdiqlamasdan qo&apos;shish
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
