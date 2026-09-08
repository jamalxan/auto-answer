"use client";

import { useState } from "react";
import { locales, localeLabels, type Locale } from "@/lib/i18n/config";
import { useLanguage } from "@/components/language-provider";

const shortLabels: Record<Locale, string> = { uz: "UZ", ru: "RU", en: "EN" };

export default function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useLanguage();
  const [open, setOpen] = useState(false);

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="label-mono flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-border-hover hover:text-foreground"
        aria-label="Change language"
      >
        {shortLabels[locale]}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-32 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
            {locales.map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => {
                  setLocale(l);
                  setOpen(false);
                }}
                className={`block w-full px-3 py-2 text-left text-sm transition-colors ${
                  l === locale
                    ? "bg-surface-hover text-accent font-medium"
                    : "text-foreground hover:bg-surface-hover"
                }`}
              >
                {localeLabels[l]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
