/** "Human-like" timing and repetition helpers (TZ 4.5). */

export const DEBOUNCE_MS = 4_000;
export const MIN_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 9_000;

/**
 * Typing delay: clamp(1.5s + len * 35ms ± 30%, 2s, 9s). `random` is injectable
 * (0..1) so tests are deterministic.
 */
export function typingDelayMs(replyLength: number, random: () => number = Math.random): number {
  const base = 1500 + replyLength * 35;
  const jitter = 1 + (random() * 2 - 1) * 0.3;
  return Math.round(Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, base * jitter)));
}

function bigrams(text: string): Map<string, number> {
  const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
  const map = new Map<string, number>();
  for (let i = 0; i < clean.length - 1; i++) {
    const gram = clean.slice(i, i + 2);
    map.set(gram, (map.get(gram) ?? 0) + 1);
  }
  return map;
}

/** Sørensen–Dice similarity on character bigrams, 0..1. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [gram, count] of ga) {
    overlap += Math.min(count, gb.get(gram) ?? 0);
    total += count;
  }
  for (const count of gb.values()) total += count;
  return total === 0 ? 0 : (2 * overlap) / total;
}

/** True when sending `candidate` right after `previous` would look like a bot loop. */
export function isRepeat(candidate: string, previous: string | null | undefined): boolean {
  return Boolean(previous) && similarity(candidate, previous as string) > 0.9;
}
