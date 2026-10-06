/**
 * Price normalizer — deterministic code, never an LLM.
 *
 * Understands: `1 200 000`, `1.200.000`, `1,2 mln`, `1.2 million`, `300 ming`,
 * `300k`, `350 000 so'm`, `сум`, `$300`, `300 dollar`, `от 500 000`,
 * `500 000 dan`. Currency defaults to UZS. Anything it cannot read becomes
 * `amount: null` so the owner is asked again instead of storing a guess.
 */

export type Currency = "UZS" | "USD" | "RUB";

export interface ParsedPrice {
  amount: number | null;
  currency: Currency;
  /** "from" price: `от 500 000`, `500 000 dan`, `...dan boshlab`. */
  isFrom: boolean;
}

const MILLION = /(?<![a-zа-яё])(mln|million|миллион\p{L}*|млн|мlн)(?![a-zа-яё])/iu;
const BILLION = /(?<![a-zа-яё])(mlrd|milliard|миллиард\p{L}*|млрд)(?![a-zа-яё])/iu;
const THOUSAND = /(?<![a-zа-яё])(ming|минг|тыс\p{L}*|thousand)(?![a-zа-яё])|(?<=\d)\s*[kк](?![a-zа-яё])/iu;

const FROM_PREFIX = /(^|[\s(])(от|from|starting|boshlab|dan boshlab)(?=[\s\d$])/iu;
const FROM_SUFFIX = /\d\s*(?:so['‘’`ʻ]?m|сум|сўм|sum|som|uzs|usd|\$|dollar|доллар|руб\p{L}*|млн|mln|ming|k)?\s*(dan|дан|dan boshlab|дан бошлаб|boshlab|бошлаб|и выше|и больше)(?![a-zа-яё])/iu;
const FROM_ATTACHED = /\d\s*(?:so['‘’`ʻ]?m|сум|сўм)(dan|дан)(?![a-zа-яё])/iu;

const NUMBER = /\d+(?:[  .,]\d+)*/;

function detectCurrency(text: string): Currency {
  if (/\$|usd|dollar|доллар|у\.\s?е|\bye\b/i.test(text)) return "USD";
  if (/₽|руб|\brub\b/i.test(text)) return "RUB";
  return "UZS";
}

/** Read the numeric token. `hasMultiplier` flips "," and "." to decimal marks. */
function readNumber(token: string, hasMultiplier: boolean, currency: Currency): number | null {
  const cleaned = token.replace(/ /g, " ").trim();
  const separators = cleaned.match(/[.,]/g) ?? [];

  if (separators.length === 1) {
    const [intPart, fracPart] = cleaned.split(/[.,]/);
    const decimalLike = fracPart.length >= 1 && fracPart.length <= 2;
    // `1,2 mln`, `2.5 mln`, `$12.50` are decimals; `1.200` / `300,000` are
    // thousands groupings.
    if (decimalLike && (hasMultiplier || currency !== "UZS")) {
      const n = Number(`${intPart.replace(/ /g, "")}.${fracPart}`);
      return Number.isFinite(n) ? n : null;
    }
  }
  const digits = cleaned.replace(/[ .,]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

export function parsePrice(input: string): ParsedPrice {
  const text = (input ?? "").trim();
  const currency = detectCurrency(text);
  const isFrom =
    FROM_PREFIX.test(text) || FROM_SUFFIX.test(text) || FROM_ATTACHED.test(text);

  const match = text.match(NUMBER);
  if (!match) return { amount: null, currency, isFrom };

  const multiplier = BILLION.test(text)
    ? 1_000_000_000
    : MILLION.test(text)
      ? 1_000_000
      : THOUSAND.test(text)
        ? 1_000
        : 1;

  const base = readNumber(match[0], multiplier > 1, currency);
  if (base === null || base <= 0) return { amount: null, currency, isFrom };

  const amount = Math.round(base * multiplier * 100) / 100;
  return { amount, currency, isFrom };
}

/** Pretty form for owner confirmations: `4 500 000 so'm`, `$300`. */
export function formatPrice(
  amount: number | null,
  currency: Currency | string = "UZS",
  isFrom = false
): string {
  if (amount === null || amount === undefined) return "narx ko'rsatilmagan";
  const grouped = Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  if (currency === "USD") return `$${grouped}${isFrom ? " dan" : ""}`;
  const unit = currency === "RUB" ? "rub" : "so'm";
  return `${grouped} ${unit}${isFrom ? "dan" : ""}`;
}

export interface PriceMention {
  amount: number;
  currency: Currency;
}

const MENTION = new RegExp(
  String.raw`(\$\s?\d[\d\s.,]*|\d[\d\s.,]*\s*(?:mln|million\p{L}*|миллион\p{L}*|млн|mlrd|млрд|ming|минг|тыс\p{L}*|k|к|so['‘’` +
    "`" +
    String.raw`ʻ]?m|сум|сўм|sum|som|uzs|usd|dollar|доллар|руб\p{L}*|₽|\$|y\.?e\.?))`,
  "giu"
);

/**
 * Every price-looking amount inside a bot reply: numbers followed by a
 * currency/multiplier word, `$`-prefixed numbers, and bare numbers with five
 * or more digits (e.g. `4 500 000`). Used by the output post-filter.
 */
export function extractPriceMentions(text: string): PriceMention[] {
  const found: PriceMention[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const parsed = parsePrice(raw);
    if (parsed.amount === null) return;
    const key = `${parsed.amount}:${parsed.currency}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ amount: parsed.amount, currency: parsed.currency });
  };

  for (const m of text.matchAll(MENTION)) push(m[0]);

  // Bare large numbers: 4500000, 4 500 000, 4.500.000
  for (const m of text.matchAll(/\d{1,3}(?:[  .,]\d{3})+|\d{5,}/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 5) push(m[0]);
  }
  return found;
}
