/**
 * Transliteration-aware retrieval for the knowledge base (TZ 21, ETAP 4.2).
 *
 * Both the customer's words and every candidate go through
 * `normalizeForMatch` (lib/triggers/keywords.ts): Cyrillic → Latin,
 * apostrophes removed, diacritics folded. "Нархи" then matches a Latin
 * product "Narx", "цена курса" matches "Ingliz tili kursi".
 *
 * Score per query token (best match wins, tokens add up):
 *   exact token            3
 *   same stem              2   kursa / kursi / kurslari ↔ kurs, narxi ↔ narx
 *   fuzzy (≥ 5 chars,      1   divan ↔ devan (Levenshtein ≤ 1)
 *          Levenshtein ≤ 1)
 *   whole query phrase    +4   "ingliz tili" inside "Ingliz tili kursi"
 *
 * Order is deterministic: score desc, then original position. Pure.
 */

import { normalizeForMatch } from "@/lib/triggers/keywords";

export interface RetrievalItem {
  id: string;
  text: string;
}

export interface RankedItem {
  id: string;
  score: number;
  /** Position in the input list. */
  index: number;
}

/**
 * Words that say nothing about *which* product / FAQ is meant, in all three
 * languages, already in normalised (Latin) form.
 */
const STOP_WORDS = new Set([
  // uz
  "narx", "narxi", "narxlari", "narxini", "qancha", "kancha", "qanchadan", "bor", "bormi", "kerak",
  "kerakmi", "va", "uchun", "bilan", "salom", "assalomu", "alaykum", "rahmat", "ha", "yoq", "yuk",
  "nima", "nega", "qachon", "kachon", "qayerda", "kaerda", "qaerda", "qaysi", "kaysi", "menga",
  "sizda", "bizda", "mumkin", "mumkinmi", "boladi", "buladi", "deb", "ham", "xam",
  "yana", "juda", "lekin", "yoki", "men", "siz", "biz", "bu", "shu", "u", "turadi", "pul",
  "necha", "nechta", "kun", "soat", "ayting", "bering", "iltimos", "ok", "xop", "hop", "mayli",
  // ru (transliterated)
  "skolko", "stoit", "stoimost", "tsena", "tseni", "tsenu", "yest", "mojno", "nujno", "nado",
  "zdravstvuyte", "privet", "dobriy", "den", "gde", "kak", "chto", "dlya", "xochu", "spasibo",
  "pojaluysta", "podskajite", "skajite", "net", "da", "mne", "vi", "vas", "vam", "ya", "mi",
  "na", "v", "s", "po", "eto", "u", "li", "ili", "i", "a", "no", "ne", "ot", "do", "za", "k",
  "kakoy", "kakaya", "kakiye", "kogda", "yesli", "seychas", "yeshyo", "yeshche", "uje", "budet",
  "mogu", "mojete", "tam", "ochen", "tolko", "toje",
  // en
  "the", "and", "how", "much", "is", "are", "price", "cost",
]);

const MIN_TOKEN = 2;
const MIN_PREFIX = 3;
const MIN_STEM = 4;
const STEM_RATIO = 0.7;
const MIN_FUZZY = 5;
const SCORE_EXACT = 3;
const SCORE_PREFIX = 2;
const SCORE_FUZZY = 1;
const SCORE_PHRASE = 4;

/**
 * Normalised, de-duplicated tokens of `text` without stop words. A query
 * made only of stop words ("Нархи канча?") keeps them: better to try than
 * to retrieve nothing.
 */
export function queryTokens(text: string): string[] {
  const all = new Set<string>();
  for (const token of normalizeForMatch(text).split(" ")) {
    if (token.length >= MIN_TOKEN) all.add(token);
  }
  const meaningful = [...all].filter((token) => !STOP_WORDS.has(token));
  return meaningful.length ? meaningful : [...all];
}

/** Levenshtein distance capped at `max + 1` (early exit). */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Same stem with different endings: "kursa" (ru genitive) ↔ "kursi" (uz
 * possessive) ↔ "kurslari". One word is a prefix of the other (≥ 3 chars),
 * or they share ≥ 4 leading chars covering ≥ 70 % of the shorter word.
 */
function sharesStem(a: string, b: string): boolean {
  const common = commonPrefixLength(a, b);
  const shorter = Math.min(a.length, b.length);
  if (common >= MIN_PREFIX && common === shorter) return true;
  return common >= MIN_STEM && common >= Math.ceil(shorter * STEM_RATIO);
}

function tokenScore(query: string, candidate: string): number {
  if (query === candidate) return SCORE_EXACT;
  if (sharesStem(query, candidate)) return SCORE_PREFIX;
  if (query.length >= MIN_FUZZY && candidate.length >= MIN_FUZZY && levenshtein(query, candidate, 1) <= 1) {
    return SCORE_FUZZY;
  }
  return 0;
}

/** Relevance of one candidate text to the query tokens (0 = unrelated). */
export function scoreText(tokens: string[], phrase: string, text: string): number {
  const normalized = normalizeForMatch(text);
  if (!normalized || !tokens.length) return 0;
  const candidates = normalized.split(" ").filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    let best = 0;
    for (const candidate of candidates) {
      const s = tokenScore(token, candidate);
      if (s > best) best = s;
      if (best === SCORE_EXACT) break;
    }
    score += best;
  }
  if (score > 0 && phrase.includes(" ") && ` ${normalized} `.includes(` ${phrase} `)) score += SCORE_PHRASE;
  return score;
}

/**
 * Items related to the query, best first (score desc, input order on ties),
 * at most `limit`. Items with score 0 are left out.
 */
export function rankByQuery(query: string, items: RetrievalItem[], limit = Infinity): RankedItem[] {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const phrase = tokens.join(" ");
  const ranked: RankedItem[] = [];
  items.forEach((item, index) => {
    const score = scoreText(tokens, phrase, item.text);
    if (score > 0) ranked.push({ id: item.id, score, index });
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, Math.max(0, limit));
}

/**
 * Up to `limit` of `items`: the related ones first (best first), then the
 * rest in their original order — the knowledge base always has something to
 * show, and the result order is stable so P#/F# ids do not shuffle between
 * retries of the same turn.
 */
function selectWithFallback<T>(query: string, items: T[], textOf: (item: T) => string, limit: number): T[] {
  if (items.length <= limit) return items;
  const ranked = rankByQuery(
    query,
    items.map((item, index) => ({ id: String(index), text: textOf(item) }))
  );
  const picked = new Set(ranked.map((r) => r.index));
  const out: T[] = ranked.map((r) => items[r.index]);
  for (let i = 0; i < items.length && out.length < limit; i++) {
    if (!picked.has(i)) out.push(items[i]);
  }
  return out.slice(0, limit);
}

export interface ProductLike {
  name: string;
  note?: string | null;
}

export interface FaqLike {
  question: string;
  answer: string;
}

export const DEFAULT_PRODUCT_LIMIT = 15;
export const DEFAULT_FAQ_LIMIT = 20;

/** Replacement for `selectProducts` / `selectKbProducts`: name + note, transliteration-aware. */
export function selectProductsV2<T extends ProductLike>(query: string, products: T[], limit = DEFAULT_PRODUCT_LIMIT): T[] {
  return selectWithFallback(query, products, (p) => `${p.name} ${p.note ?? ""}`, limit);
}

/** FAQs related to the question first (question weighs the same as answer), then the rest. */
export function selectFaqsV2<T extends FaqLike>(query: string, faqs: T[], limit = DEFAULT_FAQ_LIMIT): T[] {
  return selectWithFallback(query, faqs, (f) => `${f.question} ${f.answer}`, limit);
}
