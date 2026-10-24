/**
 * ETAP 13 — caption arithmetic and username hygiene, shared by the composer
 * (live counters) and the server (validation). Pure.
 *
 * Instagram counts characters as code points, so an emoji or a Cyrillic
 * letter is one; `Array.from` splits a string by code point.
 */

export const USERNAME_RE = /^[a-zA-Z0-9._]{1,30}$/;

// A hashtag / mention starts the text or follows whitespace; "email@x.uz"
// and "item#3" are not tags, matching what Instagram links in a caption.
const HASHTAG_RE = /(?:^|\s)#[\p{L}\p{N}_]+/gu;
const MENTION_RE = /(?:^|\s)@[A-Za-z0-9._]+/g;

export interface CaptionCounts {
  chars: number;
  hashtags: number;
  mentions: number;
}

export function countCaption(text: string): CaptionCounts {
  return {
    chars: Array.from(text).length,
    hashtags: (text.match(HASHTAG_RE) ?? []).length,
    mentions: (text.match(MENTION_RE) ?? []).length,
  };
}

/**
 * "@Foo", "foo", "Bar!", "  baz " → ["Foo", "baz"]: the leading @ and
 * whitespace go, invalid names are dropped, duplicates merge
 * case-insensitively keeping the first spelling.
 */
export function normalizeUsernames(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const name = raw.trim().replace(/^@+/, "");
    if (!USERNAME_RE.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Hashtags of a caption without the "#", lowercase, in order, unique. */
export function extractHashtags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(HASHTAG_RE) ?? []) out.add(m.trim().slice(1).toLowerCase());
  return [...out];
}

/** FR-L5: does the caption tell people what to comment? */
export function captionMentionsKeyword(caption: string | null | undefined, keywords: readonly string[]): boolean {
  if (!caption) return false;
  const text = caption.toLowerCase();
  return keywords.some((k) => k.trim() && text.includes(k.trim().toLowerCase()));
}
