import type { Metadata } from "next";
import SeoPageShell from "@/components/seo-page-shell";
import { getManychatAlternativePage } from "@/lib/seo-pages";
import { getServerLocale } from "@/lib/i18n/get-locale";

export const metadata: Metadata = {
  title: "Manychat Alternative for Instagram Comment-to-DM Campaigns",
  description:
    "A focused Manychat alternative for Instagram keyword comments, private replies, tracked links, analytics, and agency client reports.",
  alternates: { canonical: "/manychat-alternative" },
  openGraph: {
    title: "Manychat Alternative for Instagram Comment-to-DM Campaigns",
    description:
      "Use SocialAuto for focused Instagram comment-to-DM campaigns without a broad chatbot flow builder.",
    url: "/manychat-alternative",
  },
};

export default async function ManychatAlternativePage() {
  const locale = await getServerLocale();
  return <SeoPageShell config={getManychatAlternativePage(locale)} />;
}

