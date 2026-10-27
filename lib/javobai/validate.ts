/**
 * Trust ladder validators (audit 2026-10-26). The post-filter already blocks
 * phone numbers, foreign links and prices outside the product list; these
 * catch what it lets through and what an AUTO reply must never contain:
 *
 *   - a number / percentage / term ("3 kunda", "20%") not written anywhere in
 *     the knowledge the turn had
 *   - a promise the business never made (guarantee, free, refund)
 *   - the prompt itself leaking (rules, field names, role text)
 *
 * A hit never sends: the reply becomes a COPILOT draft for a human. Pure.
 */

export type ValidationIssue = "unknown_number" | "unknown_percent" | "promise" | "prompt_leak";

export const VALIDATION_ISSUE_TEXT: Record<ValidationIssue, string> = {
  unknown_number: "Bilim bazasida yo'q raqam",
  unknown_percent: "Bilim bazasida yo'q foiz",
  promise: "Biznes bermagan va'da",
  prompt_leak: "Ichki ko'rsatma oshkor bo'ldi",
};

/** Words of a commitment; allowed only when the knowledge itself uses them. */
const PROMISE_WORDS = [
  "kafolat",
  "garantiya",
  "гарантия",
  "bepul",
  "tekin",
  "бесплатно",
  "pulini qaytar",
  "pul qaytar",
  "qaytarib beramiz",
  "возврат",
  "100%",
];

/** Fragments that only appear when the model repeats its instructions or output format. */
const LEAK_MARKERS = [
  /system prompt/i,
  /\binstruction(s)?\b/i,
  /\bинструкци/i,
  /ko'rsatma(lar)?(im|ga ko'ra)/i,
  /"(intent|confidence|usedFacts|reply|handoff)"\s*:/i,
  /\b(usedFacts|askedField|neverAuto)\b/,
  /\bP\d+:\s/,
  /as an ai (language )?model/i,
  /я (языковая )?модель/i,
];

function digitsOnly(s: string): string {
  return s.replace(/[\s.,'’]/g, "");
}

/** Numbers of 2+ digits (with thousands separators), percentages and one-digit terms ("3kun") in the text. */
export function numbersIn(text: string): { numbers: string[]; percents: string[]; terms: string[] } {
  const percents = (text.match(/\d+(?:[.,]\d+)?\s?%/g) ?? []).map((p) => digitsOnly(p.replace("%", "")));
  const withoutPercents = text.replace(/\d+(?:[.,]\d+)?\s?%/g, " ");
  const numbers = (withoutPercents.match(/\d[\d\s.,]*\d/g) ?? []).map((n) => digitsOnly(n));
  // A lone digit is a claim only as a term ("3 kunda", "2 soatda"), not a count ("2 ta rang").
  const terms = [...withoutPercents.matchAll(/(?<![\d.,])(\d)\s?-?\s?(kun|soat|hafta|oy|daqiqa|день|дн|час|недел|мин)/gi)].map((m) => `${m[1]}${m[2].toLowerCase()}`);
  return { numbers, percents, terms };
}

export interface ValidateInput {
  reply: string;
  /** Everything the turn knew: the rendered KB block, the profile text, the customer's own words. */
  knowledge: string;
}

export function validateReply(input: ValidateInput): ValidationIssue[] {
  const issues = new Set<ValidationIssue>();
  const reply = input.reply ?? "";
  const knowledge = input.knowledge ?? "";
  const known = numbersIn(knowledge);
  const knownDigits = new Set([...known.numbers, ...known.percents]);
  const flatKnowledge = digitsOnly(knowledge);
  const found = numbersIn(reply);
  for (const n of found.percents) if (!knownDigits.has(n)) issues.add("unknown_percent");
  // A number counts as known when it appears verbatim, also inside a longer
  // figure the owner wrote with other separators ("1 200 000" vs "1.200.000").
  for (const n of found.numbers) if (!knownDigits.has(n) && !flatKnowledge.includes(n)) issues.add("unknown_number");
  for (const t of found.terms) if (!known.terms.includes(t)) issues.add("unknown_number");
  const lowerReply = reply.toLowerCase();
  const lowerKnowledge = knowledge.toLowerCase();
  for (const word of PROMISE_WORDS) {
    if (lowerReply.includes(word) && !lowerKnowledge.includes(word)) {
      issues.add("promise");
      break;
    }
  }
  if (LEAK_MARKERS.some((re) => re.test(reply))) issues.add("prompt_leak");
  return [...issues];
}
