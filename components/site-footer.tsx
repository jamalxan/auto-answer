"use client";

import Link from "next/link";
import LogoMark from "@/components/logo-mark";
import { useLanguage } from "@/components/language-provider";

/** The designed close: links, then the name returns at full width. */
export default function SiteFooter() {
  const { t } = useLanguage();
  const year = new Date().getFullYear();

  const productLinks = [
    { label: t.footer.linkTemplates, href: "/templates" },
    { label: t.footer.linkCommentLink, href: "/comment-link-automation" },
    { label: t.footer.linkManychat, href: "/manychat-alternative" },
    { label: t.footer.linkAgencies, href: "/instagram-dm-automation-agencies" },
  ];

  const legalLinks = [
    { label: t.footer.linkPrivacy, href: "/privacy" },
    { label: t.footer.linkTerms, href: "/terms" },
    { label: t.footer.linkDataDeletion, href: "/data-deletion" },
    { label: t.footer.linkSignIn, href: "/login" },
  ];

  return (
    <footer className="bg-midnight text-white">
      <div className="mx-auto w-full max-w-7xl px-5 pb-10 pt-24 sm:px-8 lg:pt-32">
        <div className="grid gap-12 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <LogoMark className="h-12 w-12" title="SocialAuto" />
            <p className="mt-6 max-w-sm text-lg leading-8 text-cloud/85">{t.footer.tagline}</p>
            <Link href="/login" className="btn btn-primary mt-8">
              {t.publicSite.startFree}
            </Link>
          </div>

          <div>
            <p className="text-base font-semibold">{t.footer.product}</p>
            <ul className="mt-5 space-y-3">
              {productLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-base text-cloud/75 hover:text-lime">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-base font-semibold">{t.footer.legal}</p>
            <ul className="mt-5 space-y-3">
              {legalLinks.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-base text-cloud/75 hover:text-lime">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p
          aria-hidden="true"
          className="display mt-24 overflow-hidden whitespace-nowrap text-[clamp(2.6rem,11vw,9.5rem)] leading-[0.95] tracking-[-0.04em] lg:mt-32"
        >
          Social<span className="text-lime">Auto</span>
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm text-muted">
          <p>{t.footer.rights(year)}</p>
          <p>socialauto.uz</p>
        </div>
      </div>
    </footer>
  );
}
