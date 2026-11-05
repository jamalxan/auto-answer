"use client";

import Link from "next/link";
import { Wordmark } from "@/components/logo-mark";
import { useLanguage } from "@/components/language-provider";
import LanguageSwitcher from "@/components/language-switcher";

interface PublicSiteHeaderProps {
  active?: "home" | "templates";
  /**
   * In-page sections (the landing passes its anchors). Shown from xl up in
   * place of the default links; narrower screens keep the default links.
   */
  sections?: { label: string; href: string }[];
}

/** A plain bar: lockup, a few links, one action. Solid midnight, no glass. */
export default function PublicSiteHeader({ active, sections }: PublicSiteHeaderProps) {
  const { t } = useLanguage();
  // The section anchors need room: from xl up they replace the default links.
  const hasSections = !!sections && sections.length > 0;

  const navLinks = [
    { label: t.publicSite.navTemplates, href: "/templates", key: "templates" },
    {
      label: t.publicSite.navAgencies,
      href: "/instagram-dm-automation-agencies",
      key: "agencies",
    },
  ];

  return (
    <header className="sticky top-0 z-40 bg-midnight">
      {/* Wider than the page sections (max-w-7xl): on large screens the lockup and the
          actions sit near the edges instead of being squeezed into the middle. */}
      <div className="mx-auto flex h-[4.5rem] w-full max-w-[1760px] items-center justify-between gap-3 px-4 sm:gap-4 sm:px-8 lg:px-12 2xl:px-16">
        <Link href="/" className="flex shrink-0 items-center" aria-label="SocialAuto">
          <Wordmark className="!gap-2 sm:!gap-2.5" markClassName="h-7 w-7 sm:h-8 sm:w-8" textClassName="text-[1.05rem] max-[374px]:sr-only sm:text-[1.2rem]" />
        </Link>

        {hasSections && (
          <nav aria-label="SocialAuto" className="hidden items-center gap-7 xl:flex">
            {sections.map((link) => (
              <a key={link.href} href={link.href} className="whitespace-nowrap text-[15px] font-medium text-cloud/80 hover:text-white">
                {link.label}
              </a>
            ))}
          </nav>
        )}
        <nav className={`hidden items-center gap-8 md:flex ${hasSections ? "xl:hidden" : ""}`}>
          {navLinks.map((link) => (
            <Link
              key={link.key}
              href={link.href}
              className={`text-[15px] font-medium ${
                active === link.key ? "text-lime" : "text-cloud/80 hover:text-white"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Phones (375 px) must fit the lockup, the language switch and the CTA in every
            language ("Начать бесплатно" is the longest): tighter sizes below sm. */}
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <LanguageSwitcher />
          <Link
            href="/login"
            className="hidden px-3 py-2 text-[15px] font-medium text-cloud/80 hover:text-white sm:inline-flex"
          >
            {t.publicSite.signIn}
          </Link>
          <Link
            href="/login"
            className="btn btn-primary whitespace-nowrap !px-3.5 !py-2 !text-[13px] sm:!px-5 sm:!py-2.5 sm:!text-[15px]"
          >
            {t.publicSite.startFree}
          </Link>
        </div>
      </div>
    </header>
  );
}
