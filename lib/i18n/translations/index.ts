import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { en } from "@/lib/i18n/translations/en";
import { ru } from "@/lib/i18n/translations/ru";
import { uz } from "@/lib/i18n/translations/uz";

export const dictionaries: Record<Locale, Dictionary> = { uz, ru, en };
