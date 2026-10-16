/**
 * Deterministic price-question detector (live test B-05: "Salom, narxi
 * qancha?" came back as intent OTHER, so no price_asked signal and the lead
 * never reached Hot). Merged with the model's answer by union in the turn:
 * a hit here forces the PRICE_ASKED signal whatever the model said.
 *
 * Handles Uzbek (Latin and Cyrillic), Russian and English; case,
 * punctuation and the apostrophe variants (o', o`, oʻ, o’) are normalised.
 */

/** Lowercase, unify apostrophes / quotes, drop punctuation, collapse spaces. */
export function normalizePriceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ʻʼ`´’‘']/g, "'")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Unicode-aware word edges. Written with String.raw so the \p{L} escapes reach
// the RegExp (a plain template literal swallowed the backslash, which turned
// the class into [p{L}p{N}] and removed every word boundary).
const START = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;
/** Uzbek suffixes after a stem (narx -> narxi, narxlari, narxini ...). */
const SUFFIX = String.raw`[\p{L}']*`;

/** Stem followed by any suffix. */
const stem = (s: string) => `${START}${s}${SUFFIX}`;
/** Exact words / phrases only (no suffix), alternatives allowed. */
const exact = (s: string) => `${START}(?:${s})${END}`;
/** Stem + suffix, then a price-context word (so "qancha vaqt" never matches). */
const withContext = (a: string, b: string) => `${START}${a}${SUFFIX} (?:${b})${END}`;

// A hit must carry price context: bare "qancha" / "сколько" / "how much" are
// NOT prices ("qancha vaqt", "сколько времени", "how much time").
const PATTERNS: RegExp[] = [
  // uz latin
  new RegExp(stem("narx"), "u"),
  new RegExp(stem("tan narx"), "u"),
  new RegExp(withContext("necha", String.raw`pul[\p{L}']*|so'm[\p{L}']*|som|sum|turadi|bo'ladi|boladi|tushadi`), "u"),
  new RegExp(withContext("qancha", String.raw`turadi|bo'ladi|boladi|tushadi|so'm[\p{L}']*|pul[\p{L}']*|som|sum`), "u"),
  new RegExp(`${START}nechpul${END}`, "u"),
  new RegExp(exact(String.raw`bahosi[\p{L}']*|bahosini`), "u"),
  new RegExp(stem("qiymat"), "u"),
  new RegExp(stem("prays"), "u"),
  // uz cyrillic
  new RegExp(stem("нарх"), "u"),
  new RegExp(withContext("қанча", String.raw`туради|бўлади|тушади|сўм[\p{L}']*|пул[\p{L}']*|сум`), "u"),
  new RegExp(withContext("канча", String.raw`туради|бўлади|тушади|сўм[\p{L}']*|пул[\p{L}']*|сум`), "u"),
  new RegExp(withContext("неча", String.raw`пул[\p{L}']*|сўм[\p{L}']*|сум|туради|бўлади|тушади`), "u"),
  new RegExp(exact(String.raw`баҳоси[\p{L}']*`), "u"),
  new RegExp(stem("қиймат"), "u"),
  // russian
  new RegExp(`${START}сколько (?:это |он |она |оно |они |вам |у вас |с меня |мне )?(?:стоит|стоят|будет|платить|заплатить|по цене|цена|денег|рублей|сум|сумов)${END}`, "u"),
  new RegExp(exact(String.raw`цен(?:а|ы|у|е|ой|ам|ами|ах|ник|ника|нику)`), "u"),
  new RegExp(exact("почем"), "u"),
  new RegExp(stem("стоимост"), "u"),
  new RegExp(stem("прайс"), "u"),
  // нечта пул / нечта сўм (uz cyrillic "how much money")
  new RegExp(withContext("нечта", String.raw`пул[\p{L}']*|сўм[\p{L}']*|сум`), "u"),
  // english
  new RegExp(exact(String.raw`price|prices|pricing|priced|pricelist`), "u"),
  new RegExp(exact(String.raw`cost|costs`), "u"),
  new RegExp(`${START}how much (?:is|are|does|do|for|would|will|it|they)${END}`, "u"),
];

/** True when the text asks for a price in uz (latin / cyrillic), ru or en. */
export function detectsPriceQuestion(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = normalizePriceText(text);
  if (!normalized) return false;
  return PATTERNS.some((p) => p.test(normalized));
}
