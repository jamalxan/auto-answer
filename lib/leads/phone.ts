// The core API with explicit metadata behaves identically under Next, Vitest and
// tsx (the worker); the "/max" wrapper loses its metadata when loaded as CJS.
import { parsePhoneNumberFromString as parseWithMetadata } from "libphonenumber-js/core";
import metadata from "libphonenumber-js/metadata.max.json";

const parsePhoneNumberFromString = (text: string, region: "UZ") =>
  parseWithMetadata(text, region, metadata);

export interface ParsedPhone {
  e164: string;
  raw: string;
}

/**
 * Candidate phone-number spans inside free text: an optional "+", then digits
 * grouped by spaces, dashes, dots or parentheses. At least 9 digits overall
 * are required before we even ask libphonenumber about it.
 */
const CANDIDATE = /(?<![\w.])\+?\(?\d[\d\s().-]{6,}\d(?![\w])/g;

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Validate one phone-like string. Default region is UZ, so `901234567`,
 * `90 123 45 67` and `(90) 123-45-67` all resolve to +998901234567.
 * Foreign numbers are accepted when libphonenumber says they are valid.
 */
export function parsePhone(input: string, defaultRegion: "UZ" = "UZ"): ParsedPhone | null {
  const raw = input.trim();
  if (!raw) return null;
  const digits = digitsOf(raw);
  if (digits.length < 9 || digits.length > 15) return null;

  const hasPlus = raw.startsWith("+");
  let candidate: string;

  if (hasPlus) {
    candidate = `+${digits}`;
  } else if (digits.length === 9) {
    // Local Uzbek form: operator code + 7 digits.
    candidate = `+998${digits}`;
  } else if (digits.length === 12 && digits.startsWith("998")) {
    candidate = `+${digits}`;
  } else if (digits.length === 11 && /^[78]/.test(digits)) {
    // Russian-style 8 9xx... / 7 9xx... numbers.
    candidate = `+7${digits.slice(1)}`;
  } else {
    candidate = `+${digits}`;
  }

  const parsed = parsePhoneNumberFromString(candidate, defaultRegion);
  if (!parsed || !parsed.isValid()) {
    // 9 digits that are not a valid UZ mobile might still be a foreign
    // number typed without a "+"; we do not guess those.
    return null;
  }
  return { e164: parsed.number, raw };
}

/**
 * Find the first valid phone number inside a customer message. Numbers spelled
 * out in words are never accepted (TZ 4.2) — only digits.
 */
export function extractPhone(text: string): ParsedPhone | null {
  if (!text) return null;
  const whole = parsePhone(text.length <= 24 ? text : "");
  if (whole) return whole;

  const matches = text.match(CANDIDATE) ?? [];
  for (const match of matches) {
    const parsed = parsePhone(match);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * True when the message contains something that looks like an attempt at a
 * phone number (>= 5 digits) without being a valid one — used to answer with
 * "the number looks incomplete" instead of the generic ask.
 */
export function looksLikeBrokenPhone(text: string): boolean {
  if (extractPhone(text)) return false;
  const digits = digitsOf(text);
  return digits.length >= 5 && digits.length <= 15;
}

/** Remove a phone number from text so the remaining words can be read as a name. */
export function stripPhone(text: string): string {
  return text
    .replace(CANDIDATE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "")
    .trim();
}

export function phoneDigits(e164: string): string {
  return digitsOf(e164);
}
