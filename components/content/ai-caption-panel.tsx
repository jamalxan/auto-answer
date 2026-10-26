"use client";

/**
 * "AI bilan yozish" (spec §5.10 FR-AI1): topic + tone + language → three
 * caption variants and up to 15 hashtags. Choosing a variant replaces the
 * caption; the hashtags are appended on request. Nothing is saved here —
 * the composer's own save does that.
 */

import { useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { inputClass, primaryButton, secondaryButton } from "./ui";
import { CONTENT_API, countCaption, jsonInit, requestJson, type PostTypeValue } from "./shared";

const TONES = [
  ["friendly", "Samimiy"],
  ["formal", "Rasmiy"],
  ["playful", "Quvnoq"],
  ["inspiring", "Ilhomlantiruvchi"],
  ["sales", "Sotuvchi"],
] as const;
const LANGUAGES = [
  ["uz", "O'zbekcha"],
  ["ru", "Ruscha"],
  ["en", "Inglizcha"],
] as const;

interface Result {
  variants: string[];
  hashtags: string[];
}

/** The caption with the hashtags appended on a new paragraph, skipping ones it already has. */
export function appendHashtags(caption: string, tags: string[]): string {
  const have = new Set((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(1).toLowerCase()));
  const fresh = tags.filter((t) => !have.has(t.toLowerCase())).map((t) => `#${t}`);
  if (fresh.length === 0) return caption;
  return `${caption.trimEnd()}${caption.trim() ? "\n\n" : ""}${fresh.join(" ")}`;
}

export default function AiCaptionPanel({
  type,
  caption,
  limits,
  onChange,
}: {
  type: PostTypeValue;
  caption: string;
  limits: { captionChars: number; hashtags: number };
  onChange: (caption: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [tone, setTone] = useState<(typeof TONES)[number][0]>("friendly");
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number][0]>("uz");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    const res = await requestJson<Result>(`${CONTENT_API}/ai/caption`, jsonInit("POST", { topic, tone, language, postType: type, existingCaption: caption.trim() || undefined }));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setResult(res.data);
  }

  if (!open) {
    return (
      <button type="button" className={`${secondaryButton} !py-1 text-xs`} onClick={() => setOpen(true)}>
        ✦ AI bilan yozish
      </button>
    );
  }

  const withTags = result ? appendHashtags(caption, result.hashtags) : caption;
  const tagsFit = countCaption(withTags).hashtags <= limits.hashtags && Array.from(withTags).length <= limits.captionChars;

  return (
    <div className="space-y-3 rounded-2xl bg-violet/10 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">AI bilan yozish</span>
        <button type="button" className="text-xs text-muted hover:text-foreground" onClick={() => setOpen(false)}>
          Yopish
        </button>
      </div>
      <textarea
        className={`${inputClass} min-h-16`}
        value={topic}
        maxLength={500}
        onChange={(e) => setTopic(e.target.value)}
        placeholder="Post nima haqida? Masalan: yangi divan kolleksiyasi, 20% chegirma hafta oxirigacha"
      />
      <div className="flex flex-wrap gap-2">
        <select className={`${inputClass} !w-auto`} value={tone} onChange={(e) => setTone(e.target.value as typeof tone)} aria-label="Ohang">
          {TONES.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select className={`${inputClass} !w-auto`} value={language} onChange={(e) => setLanguage(e.target.value as typeof language)} aria-label="Til">
          {LANGUAGES.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" className={primaryButton} disabled={busy || topic.trim().length < 3} onClick={() => void generate()}>
          {busy ? "Yozilmoqda…" : result ? "Qayta yozish" : "3 ta variant"}
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {result && (
        <div className="space-y-2">
          {result.variants.map((v, i) => (
            <div key={i} className="space-y-2 inset p-3">
              <p className="whitespace-pre-wrap text-sm">{v}</p>
              <button type="button" className={`${secondaryButton} !py-1 text-xs`} onClick={() => onChange(v)}>
                Shu variantni olish
              </button>
            </div>
          ))}
          {result.hashtags.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted">{result.hashtags.map((t) => `#${t}`).join(" ")}</p>
              <button type="button" className={`${secondaryButton} !py-1 text-xs`} disabled={!tagsFit || withTags === caption} onClick={() => onChange(withTags)}>
                Hashtaglarni caption&apos;ga qo&apos;shish
              </button>
              {!tagsFit && <p className="text-xs text-warning">Qo&apos;shilsa caption limitdan oshadi ({limits.hashtags} ta # yoki {limits.captionChars} belgi).</p>}
            </div>
          )}
          <p className="text-[11px] text-muted">AI matnini chiqarishdan oldin o&apos;qib chiqing: narx, sana va va&apos;dalarni tekshiring.</p>
        </div>
      )}
    </div>
  );
}
