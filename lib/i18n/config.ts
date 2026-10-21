export const locales = ["uz", "ru", "en"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "uz";

export const localeLabels: Record<Locale, string> = {
  uz: "O'zbekcha",
  ru: "Русский",
  en: "English",
};

export const LOCALE_COOKIE = "NEXT_LOCALE";

/**
 * What the user can pick. "uz-Cyrl" is Uzbek in Cyrillic script: it shares all
 * content with "uz" (its base {@link Locale}) and is produced by
 * transliteration, so content tables keyed by Locale stay three-way.
 */
export const uiLocales = ["uz", "uz-Cyrl", "ru", "en"] as const;
export type UiLocale = (typeof uiLocales)[number];

export const uiLocaleLabels: Record<UiLocale, string> = {
  uz: "O'zbekcha",
  "uz-Cyrl": "Ўзбекча",
  ru: "Русский",
  en: "English",
};

export function isUiLocale(value: string | undefined | null): value is UiLocale {
  return !!value && (uiLocales as readonly string[]).includes(value);
}

/** Content locale behind a UI locale (uz-Cyrl renders the Uzbek content). */
export function baseLocale(ui: UiLocale): Locale {
  return ui === "uz-Cyrl" ? "uz" : ui;
}

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value);
}
