/**
 * Output post-filter (TZ 4.7). The system prompt asks the model to behave; this
 * is the deterministic guarantee. Any blocked reply is replaced by a template
 * and recorded in `assistant_events`.
 */

import { extractPhone } from "@/lib/leads/phone";
import { extractPriceMentions } from "./price";

export type BlockReason =
  | "phone_number"
  | "foreign_url"
  | "price_forbidden"
  | "price_not_in_list"
  | "too_long"
  | "empty"
  | "formatting";

export interface FilterContext {
  pricePolicy: "NEVER" | "FROM_ONLY" | "EXACT";
  /** Every price in the owner's product list (any product, not only prompt-visible ones). */
  knownPrices: Array<{ amount: number; currency: string }>;
  /** Text the owner wrote — URLs found there are allowed. */
  profileText: string;
  maxChars?: number;
}

export interface FilterResult {
  ok: boolean;
  reason?: BlockReason;
  /** Reply with harmless markdown removed. Only meaningful when ok. */
  text: string;
}

const URL_PATTERN =
  /(https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9-]+\.(?:com|uz|ru|org|net|io|me|tg|ly|info|biz|app)\b[^\s]*|t\.me\/[^\s]+|@[a-z0-9_.]{4,})/gi;

function urlsIn(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map((u) => u.toLowerCase().replace(/[.,;:!?)]+$/, ""));
}

function stripFormatting(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/`/g, "")
    .trim();
}

export function filterReply(reply: string, context: FilterContext): FilterResult {
  const max = context.maxChars ?? 300;
  const text = stripFormatting(reply ?? "");

  if (!text) return { ok: false, reason: "empty", text };
  if (text.length > max) return { ok: false, reason: "too_long", text };
  // A poem / list / essay smuggled in by a prompt injection has many lines.
  if (text.split("\n").filter((l) => l.trim()).length > 3) {
    return { ok: false, reason: "formatting", text };
  }

  // The bot never writes a phone number (the customer's own number is only
  // ever echoed by the fixed final-message template, which skips this filter).
  if (extractPhone(text)) return { ok: false, reason: "phone_number", text };

  const allowedUrls = new Set(urlsIn(context.profileText));
  for (const url of urlsIn(text)) {
    if (!allowedUrls.has(url)) return { ok: false, reason: "foreign_url", text };
  }

  const mentions = extractPriceMentions(text);
  if (mentions.length > 0) {
    if (context.pricePolicy === "NEVER") return { ok: false, reason: "price_forbidden", text };
    for (const mention of mentions) {
      const known = context.knownPrices.some(
        (p) => p.amount === mention.amount && p.currency === mention.currency
      );
      if (!known) return { ok: false, reason: "price_not_in_list", text };
    }
  }

  return { ok: true, text };
}
