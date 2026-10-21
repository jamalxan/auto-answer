import type { UiLocale } from "@/lib/i18n/config";
import { uzLatinToCyrillic } from "@/lib/i18n/translit";

/** Exact-phrase table: Uzbek (Latin) text -> translation for one target locale. */
export type PhraseTable = Record<string, string>;

/**
 * Translate one rendered text run. Uzbek Cyrillic is transliterated
 * (everything is covered); ru/en come from the phrase table and fall back to
 * the original Uzbek text when a phrase is unknown, so nothing ever blanks out.
 * Surrounding whitespace is preserved because React text nodes carry it.
 */
export function translateText(text: string, ui: UiLocale, table?: PhraseTable): string {
  if (ui === "uz") return text;
  if (ui === "uz-Cyrl") return uzLatinToCyrillic(text);
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m || !m[2]) return text;
  const hit = table?.[m[2]];
  return hit === undefined ? text : m[1] + hit + m[3];
}
