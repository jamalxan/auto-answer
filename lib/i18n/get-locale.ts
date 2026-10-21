import { cookies } from "next/headers";
import {
  baseLocale,
  defaultLocale,
  isUiLocale,
  LOCALE_COOKIE,
  type Locale,
  type UiLocale,
} from "@/lib/i18n/config";

/** Server-side helper: the exact UI locale the user saved (may be uz-Cyrl). */
export async function getServerUiLocale(): Promise<UiLocale> {
  const store = await cookies();
  const value = store.get(LOCALE_COOKIE)?.value;
  return isUiLocale(value) ? value : defaultLocale;
}

/** Server-side helper: the content locale, defaulting to Uzbek. */
export async function getServerLocale(): Promise<Locale> {
  return baseLocale(await getServerUiLocale());
}
