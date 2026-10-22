"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";

export interface LeadCards {
  leads30: number;
  conversionPct: number;
  assistantChats: number;
  undelivered: number;
}

/**
 * Dashboard cards: leads, phone-capture rate and undelivered leads (red when > 0).
 * `initial` comes from the server render; without it the cards load themselves.
 */
export default function LeadStatCards({ initial = null }: { initial?: LeadCards | null }) {
  const { t } = useLanguage();
  const D = t.assistant.dashboard;
  const [cards, setCards] = useState<LeadCards | null>(initial);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    fetch("/api/assistant/overview", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (!cancelled && payload.success) setCards(payload.data.cards);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initial]);

  if (!cards) return null;

  const hasUndelivered = cards.undelivered > 0;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
      <div className="panel rounded-2xl p-4 sm:p-5">
        <p className="break-words text-xs font-semibold leading-snug text-muted">
          {D.leadsPeriod} · {D.last30}
        </p>
        <p className="display mt-3 text-2xl tabular-nums text-white sm:text-[1.75rem]">
          {cards.leads30}
        </p>
      </div>
      <div className="panel rounded-2xl p-4 sm:p-5" title={D.conversionHelp}>
        <p className="break-words text-xs font-semibold leading-snug text-muted">{D.conversion}</p>
        <p className="display mt-3 text-2xl tabular-nums text-white sm:text-[1.75rem]">
          {cards.conversionPct}%
        </p>
        <p className="mt-3 text-xs leading-5 text-muted">{D.conversionHelp}</p>
      </div>
      {/* A filled error tint instead of the old red hairline when leads are stuck. */}
      <div className={`panel rounded-2xl p-4 sm:p-5 ${hasUndelivered ? "bg-error/12" : ""}`}>
        <p className="break-words text-xs font-semibold leading-snug text-muted">{D.undelivered}</p>
        <p
          className={`display mt-3 text-2xl tabular-nums sm:text-[1.75rem] ${
            hasUndelivered ? "text-error" : "text-white"
          }`}
        >
          {cards.undelivered}
        </p>
        <p className="mt-3 text-xs leading-5 text-muted">{D.undeliveredHelp}</p>
      </div>
    </div>
  );
}
