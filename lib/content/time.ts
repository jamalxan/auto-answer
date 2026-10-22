/**
 * ETAP 13 — wall-clock ↔ UTC without a date library (FR-S1). The database
 * stores UTC; the composer shows the workspace zone (Asia/Tashkent by
 * default). Pure, Intl-based, so DST zones work too.
 */

export const DEFAULT_TIMEZONE = "Asia/Tashkent";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsIn(d: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, number> = {};
  for (const part of fmt.formatToParts(d)) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }
  return { year: map.year, month: map.month, day: map.day, hour: map.hour % 24, minute: map.minute, second: map.second };
}

/** Offset of `tz` from UTC at instant `d`, in milliseconds. */
function offsetMs(d: Date, tz: string): number {
  const p = partsIn(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** "2026-10-24" + "19:00" in `tz` → the UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  // Two passes handle the offset change at a DST boundary.
  let guess = naive - offsetMs(new Date(naive), tz);
  guess = naive - offsetMs(new Date(guess), tz);
  return new Date(guess);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function utcToZoned(d: Date, tz: string): { date: string; time: string } {
  const p = partsIn(d, tz);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** "24-okt, 19:00" style label for buttons and cards. */
export function formatZoned(d: Date, tz: string): string {
  const p = partsIn(d, tz);
  const months = ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"];
  return `${p.day}-${months[p.month - 1]}, ${pad(p.hour)}:${pad(p.minute)}`;
}
