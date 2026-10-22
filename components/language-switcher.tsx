"use client";

import { useState } from "react";
import { uiLocales, uiLocaleLabels, type UiLocale } from "@/lib/i18n/config";
import { useLanguage } from "@/components/language-provider";

const shortLabels: Record<UiLocale, string> = { uz: "UZ", "uz-Cyrl": "ЎЗ", ru: "RU", en: "EN" };

export default function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { uiLocale: locale, setLocale } = useLanguage();
  const [open, setOpen] = useState(false);

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`grid h-10 min-w-10 place-items-center rounded-full px-2.5 text-xs font-semibold transition-colors ${
          open ? "bg-surface-hover text-white" : "bg-surface text-muted hover:bg-surface-hover hover:text-white"
        }`}
        aria-label="Change language"
      >
        {shortLabels[locale]}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="panel absolute right-0 z-20 mt-2 w-40 overflow-hidden rounded-2xl p-1.5 shadow-float"
          >
            {uiLocales.map((l) => (
              <button
                key={l}
                type="button"
                role="menuitem"
                onClick={() => {
                  setLocale(l);
                  setOpen(false);
                }}
                className={`block w-full rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                  l === locale
                    ? "bg-violet font-semibold text-white"
                    : "text-muted hover:bg-surface-hover hover:text-white"
                }`}
              >
                {uiLocaleLabels[l]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
