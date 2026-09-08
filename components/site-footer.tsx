"use client";

import Link from "next/link";
import { useLanguage } from "@/components/language-provider";

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
  ];

  return (
    <footer className="border-t-2 border-border">
      <div className="mx-auto w-full max-w-7xl px-5 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-[1.2fr_1fr_1fr]">
          <div>
            <Link href="/" className="font-display text-lg font-extrabold text-foreground">
              SocialAuto
            </Link>
            <p className="mt-3 max-w-xs text-sm leading-6 text-muted">{t.footer.tagline}</p>
          </div>

          <div>
            <p className="label-mono text-[11px] font-bold text-muted">{t.footer.product}</p>
            <ul className="mt-4 space-y-2">
              {productLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted transition hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="label-mono text-[11px] font-bold text-muted">{t.footer.legal}</p>
            <ul className="mt-4 space-y-2">
              {legalLinks.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted transition hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href="/login"
                  className="text-sm text-muted transition hover:text-foreground"
                >
                  {t.footer.linkSignIn}
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <p className="mt-10 border-t border-border pt-6 text-xs text-muted">
          {t.footer.rights(year)}
        </p>
      </div>
    </footer>
  );
}
