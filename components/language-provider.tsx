"use client";

/**
 * Language context for the client-rendered app shell (dashboard/panel pages).
 * Server components pick their locale straight from the cookie via
 * lib/i18n/get-locale.ts; this provider exists so client components can read
 * and change the locale without a full page reload.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { baseLocale, LOCALE_COOKIE, type Locale, type UiLocale } from "@/lib/i18n/config";
import { dictionaries } from "@/lib/i18n/translations";
import type { Dictionary } from "@/lib/i18n/dictionary";

interface LanguageContextValue {
  /** Content locale (uz-Cyrl renders the Uzbek content). */
  locale: Locale;
  /** What the user picked, including the Cyrillic Uzbek script. */
  uiLocale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  t: Dictionary;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({
  initialLocale,
  children,
}: {
  initialLocale: UiLocale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<UiLocale>(initialLocale);
  const router = useRouter();

  const setLocale = useCallback(
    (next: UiLocale) => {
      setLocaleState(next);
      // A year — this is a plain preference, not a session artifact.
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
      // Re-renders server components (login, homepage, legal pages) with the
      // new cookie value so they switch language without a full reload.
      router.refresh();
    },
    [router]
  );

  const value = useMemo<LanguageContextValue>(
    () => ({ locale: baseLocale(locale), uiLocale: locale, setLocale, t: dictionaries[baseLocale(locale)] }),
    [locale, setLocale]
  );

  return (
    <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return ctx;
}
