import type { Metadata } from "next";
import SeoPageShell from "@/components/seo-page-shell";
import { getAgenciesSeoPage } from "@/lib/seo-pages";
import { getServerLocale } from "@/lib/i18n/get-locale";

export const metadata: Metadata = {
  title: "Instagram DM Automation for Agencies",
  description:
    "Instagram DM automation for agencies with multi-account workspaces, comment-to-DM campaigns, tracked links, and shareable client reports.",
  alternates: { canonical: "/instagram-dm-automation-agencies" },
  openGraph: {
    title: "Instagram DM Automation for Agencies",
    description:
      "Manage client Instagram comment-to-DM campaigns with SocialAuto agency workspaces.",
    url: "/instagram-dm-automation-agencies",
  },
};

export default async function InstagramDmAutomationAgenciesPage() {
  const locale = await getServerLocale();
  return <SeoPageShell config={getAgenciesSeoPage(locale)} />;
}

