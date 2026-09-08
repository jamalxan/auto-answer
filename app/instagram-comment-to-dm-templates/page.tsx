import type { Metadata } from "next";
import SeoPageShell from "@/components/seo-page-shell";
import { getTemplatesSeoPage } from "@/lib/seo-pages";
import { getServerLocale } from "@/lib/i18n/get-locale";

export const metadata: Metadata = {
  title: "Instagram Comment-to-DM Templates for Campaigns",
  description:
    "Browse Instagram comment-to-DM templates for lead magnets, product links, price replies, launch waitlists, creators, and agencies.",
  alternates: { canonical: "/instagram-comment-to-dm-templates" },
  openGraph: {
    title: "Instagram Comment-to-DM Templates for Campaigns",
    description:
      "Start with SocialAuto templates for high-intent Instagram keyword comments and private replies.",
    url: "/instagram-comment-to-dm-templates",
  },
};

export default async function InstagramCommentToDmTemplatesPage() {
  const locale = await getServerLocale();
  return <SeoPageShell config={getTemplatesSeoPage(locale)} />;
}

