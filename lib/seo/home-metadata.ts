/**
 * The landing page's <head> in the visitor's language. The locale comes
 * from the NEXT_LOCALE cookie (the page is dynamic anyway), so the title,
 * description, keywords and og:locale follow it instead of staying English
 * for an Uzbek visitor.
 */

import type { Metadata } from "next";
import type { Locale } from "@/lib/i18n/config";

export interface HomeSeoCopy {
  /** ≤ 60 characters, brand last. */
  title: string;
  /** 140–160 characters: benefit + what it is. */
  description: string;
  keywords: string[];
  ogLocale: string;
}

export const HOME_SEO: Record<Locale, HomeSeoCopy> = {
  uz: {
    title: "SocialAuto — Instagram izoh → DM va SMM avtomatlashtirish",
    description:
      "Izohga kalit so'z yozilsa, DM bir soniyada ketadi. Instagram, Facebook, Threads, YouTube va Telegram uchun AI javoblar, kontent reja va CRM — rasmiy Meta API asosida.",
    keywords: [
      "instagram avtomatlashtirish",
      "izoh dm avtomatik",
      "instagram comment to dm",
      "smm avtomatlashtirish",
      "manychat alternativa",
      "kontent reja",
      "ai javob instagram",
      "telegram kanal avtomatlashtirish",
    ],
    ogLocale: "uz_UZ",
  },
  ru: {
    title: "SocialAuto — автоматизация Instagram: комментарий → DM",
    description:
      "Ключевое слово в комментарии — и DM уходит за секунду. AI-ответы, контент-план и CRM для Instagram, Facebook, Threads, YouTube и Telegram на официальном Meta API.",
    keywords: [
      "автоматизация instagram",
      "комментарий в директ",
      "instagram comment to dm",
      "smm автоматизация",
      "альтернатива manychat",
      "контент-план",
      "ai ответы instagram",
      "автоматизация telegram канала",
    ],
    ogLocale: "ru_RU",
  },
  en: {
    title: "SocialAuto — Instagram comment-to-DM and social automation",
    description:
      "A keyword comment sends a DM within a second. AI replies, a cross-network content plan and a CRM for Instagram, Facebook, Threads, YouTube and Telegram, on the official Meta API.",
    keywords: [
      "instagram automation",
      "comment to DM",
      "instagram private replies",
      "social media scheduler",
      "manychat alternative",
      "ai comment replies",
      "telegram channel automation",
      "uzbekistan smm",
    ],
    ogLocale: "en_US",
  },
};

const OG_IMAGE = { url: "/og-image-1200x630.png", width: 1200, height: 630 };

export function homeMetadata(locale: Locale): Metadata {
  const copy = HOME_SEO[locale];
  return {
    title: { absolute: copy.title },
    description: copy.description,
    keywords: copy.keywords,
    alternates: { canonical: "/" },
    openGraph: {
      title: copy.title,
      description: copy.description,
      url: "/",
      siteName: "SocialAuto",
      locale: copy.ogLocale,
      type: "website",
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.description,
      images: [OG_IMAGE.url],
    },
  };
}
