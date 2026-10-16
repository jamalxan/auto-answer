/**
 * Lead-quality validators shared by lead capture (assistant, JavobAI) and lead
 * creation. Pure functions: no DB, no I/O.
 *
 *  - `validateLeadName`   rejects greetings, questions, URLs, emoji-only text
 *  - `normalizeLeadPhone` +998XXXXXXXXX (also accepts foreign valid numbers)
 *  - `classifyLead`       "LEAD" needs a valid phone OR an explicit buying interest
 */

import { parsePhone } from "./phone";

export type LeadKind = "LEAD" | "CONTACT";

/** Greetings, fillers and question words that are never a person's name. */
const NOT_A_NAME = new Set([
  "salom", "assalomu", "alaykum", "aleykum", "assalom", "hello", "hi", "hey", "hola",
  "привет", "здравствуйте", "здравствуй", "добрый", "день", "вечер", "утро",
  "ha", "yo'q", "yoq", "bor", "kerak", "rahmat", "спасибо", "да", "нет", "ok", "okay",
  "xo'p", "xop", "mayli", "mana", "raqam", "raqamim", "nomer", "nomerim", "telefon",
  "вот", "номер", "мой", "thanks", "thx", "yes", "no", "good", "morning", "evening",
  "narxi", "narx", "qancha", "necha", "qanaqa", "qayerda", "qachon", "nima", "nega",
  "цена", "сколько", "почему", "что", "how", "much", "price", "what", "why",
]);

const URL_RE = /(https?:\/\/|www\.|\b[\w-]+\.(com|uz|ru|net|org|me|io|ly)\b|t\.me\/|@\w)/i;

/** A usable name: 2–40 chars, 1–4 words, letters only, not a greeting/question/URL. Returns the cleaned name or null. */
export function validateLeadName(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("?") || URL_RE.test(trimmed)) return null;
  const cleaned = trimmed
    .replace(/[^\p{L}\s'‘’`ʻ.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 40) return null;
  if (!/\p{L}.*\p{L}/u.test(cleaned)) return null; // emoji-only / punctuation-only
  const words = cleaned.split(" ");
  if (words.length > 4) return null;
  // Reject only when the WHOLE string is greetings / fillers / question words
  // ("Salom", "Assalomu alaykum"); "Good Boy" or "Mr. Bor" are real names.
  if (words.every((w) => NOT_A_NAME.has(w.toLowerCase().replace(/[.,]+$/, "")))) return null;
  return cleaned.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());
}

export interface NormalizedPhone {
  /** E.164, e.g. +998901234567; null when the input is not a valid number. */
  e164: string | null;
  raw: string;
  /** true when the input could not be normalised (kept raw, flagged). */
  invalid: boolean;
}

/**
 * Accepts 901234567, 998901234567, +998 90 123-45-67, (90) 123 45 67 …
 * Anything that is not a valid number is returned as `{ e164: null, invalid: true }`
 * so callers can keep the raw text but never treat it as a phone.
 */
export function normalizeLeadPhone(input: string | null | undefined): NormalizedPhone {
  const raw = (input ?? "").trim();
  if (!raw) return { e164: null, raw, invalid: false };
  const digits = raw.replace(/\D/g, "");
  if (!raw.startsWith("+")) {
    // Russian-style "8 901 234 56 78" / "7 901 ..." must not silently become +7.
    if (digits.length === 11 && /^[78]/.test(digits)) return { e164: null, raw, invalid: true };
    // Local trunk form 0XXXXXXXXX (0 + operator + 7 digits).
    if (digits.length === 10 && digits.startsWith("0")) {
      const local = parsePhone(digits.slice(1));
      return local ? { e164: local.e164, raw, invalid: false } : { e164: null, raw, invalid: true };
    }
  }
  const parsed = parsePhone(raw);
  return parsed ? { e164: parsed.e164, raw, invalid: false } : { e164: null, raw, invalid: true };
}

export function isValidLeadPhone(input: string | null | undefined): boolean {
  return normalizeLeadPhone(input).e164 !== null;
}

/** Explicit buying interest = a non-trivial product/service the customer named. */
export function hasBuyingInterest(productInterest: string | null | undefined): boolean {
  const text = (productInterest ?? "").trim();
  return text.length >= 2 && /\p{L}/u.test(text);
}

export function classifyLead(input: {
  phoneE164?: string | null;
  productInterest?: string | null;
}): LeadKind {
  return input.phoneE164 || hasBuyingInterest(input.productInterest) ? "LEAD" : "CONTACT";
}

/** Test/sandbox leads: explicit name marker or a sandbox conversation source. */
export function isTestLeadName(name: string | null | undefined): boolean {
  return /^\s*\[test\]/i.test(name ?? "");
}
