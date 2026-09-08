import type { Locale } from "@/lib/i18n/config";

const SHORT_MONTHS: Record<Locale, string[]> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ru: ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."],
  uz: ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"],
};

/**
 * Locale-correct "short month + day" formatting for client components,
 * independent of the browser's own Intl/ICU data. Chrome's bundled ICU is
 * missing proper short month names for "uz" and silently falls back to a
 * generic "M08 11" pattern, even though the same call works fine for ru/en
 * in the browser and for all three locales server-side (Node ships full-icu).
 * These tables reproduce the exact output Node's Intl.DateTimeFormat gives
 * for each locale, so the two never visibly disagree.
 */
export function formatShortMonthDay(
  date: Date,
  locale: Locale,
  options?: { utc?: boolean }
): string {
  const day = options?.utc ? date.getUTCDate() : date.getDate();
  const monthIndex = options?.utc ? date.getUTCMonth() : date.getMonth();
  const month = SHORT_MONTHS[locale][monthIndex];
  if (locale === "uz") return `${day}-${month}`;
  if (locale === "ru") return `${day} ${month}`;
  return `${month} ${day}`;
}

/**
 * Same as {@link formatShortMonthDay}, with a time-of-day appended — 24-hour
 * for ru/uz, 12-hour with AM/PM for en, matching Node's own
 * `toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit",
 * minute: "2-digit" })` output for each of the three locales.
 */
export function formatShortMonthDayTime(date: Date, locale: Locale): string {
  const minutes = String(date.getMinutes()).padStart(2, "0");
  let time: string;
  if (locale === "en") {
    const hours12 = date.getHours() % 12 || 12;
    const period = date.getHours() < 12 ? "AM" : "PM";
    time = `${String(hours12).padStart(2, "0")}:${minutes} ${period}`;
  } else {
    time = `${String(date.getHours()).padStart(2, "0")}:${minutes}`;
  }
  return `${formatShortMonthDay(date, locale)}, ${time}`;
}
