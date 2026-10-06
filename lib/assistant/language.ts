export type Lang = "uz_latn" | "uz_cyrl" | "ru";

const UZ_CYRL_LETTERS = /[ўқғҳЎҚҒҲ]/;
const RU_ONLY_LETTERS = /[ыэёщъЫЭЁЩЪ]/;
const UZ_CYRL_WORDS = /\b(ва|учун|керак|бор|нима|қанча|нархи|салом|ассалому|раҳмат|йўқ|ҳа|қилиб|менга|сизда)\b/i;
const RU_WORDS = /\b(и|для|нужно|есть|как|сколько|привет|здравствуйте|спасибо|нет|да|мне|можно|хочу|цена|стоит)\b/i;

/**
 * Cheap deterministic language guess from the customer's text. The LLM also
 * reports `language`, but code needs a value for templates when the LLM is down.
 */
export function detectLanguage(text: string, fallback: Lang = "uz_latn"): Lang {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return fallback;
  const cyrillic = letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length;

  if (cyrillic / letters.length < 0.5) return "uz_latn";
  if (UZ_CYRL_LETTERS.test(text)) return "uz_cyrl";
  if (RU_ONLY_LETTERS.test(text)) return "ru";
  if (UZ_CYRL_WORDS.test(text) && !RU_WORDS.test(text)) return "uz_cyrl";
  return "ru";
}

export function normalizeLang(value: unknown, fallback: Lang): Lang {
  return value === "uz_latn" || value === "uz_cyrl" || value === "ru" ? value : fallback;
}
