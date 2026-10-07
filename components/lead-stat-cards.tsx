"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";

interface Cards {
  leads30: number;
  conversionPct: number;
  assistantChats: number;
  undelivered: number;
}

/** Dashboard cards: leads, phone-capture rate and undelivered leads (red when > 0). */
export default function LeadStatCards() {
  const { t } = useLanguage();
  const D = t.assistant.dashboard;
  const [cards, setCards] = useState<Cards | null>(null);

  useEffect(() => {
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
  }, []);

  if (!cards) return null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
      <div className="panel rounded-xl p-4">
        <p className="label-mono text-[11px] text-muted">
          {D.leadsPeriod} · {D.last30}
        </p>
        <p className="font-display mt-1 text-2xl font-extrabold text-foreground">{cards.leads30}</p>
      </div>
      <div className="panel rounded-xl p-4" title={D.conversionHelp}>
        <p className="label-mono text-[11px] text-muted">{D.conversion}</p>
        <p className="font-display mt-1 text-2xl font-extrabold text-foreground">{cards.conversionPct}%</p>
        <p className="mt-1 text-xs text-muted">{D.conversionHelp}</p>
      </div>
      <div className={`panel rounded-xl p-4 ${cards.undelivered > 0 ? "border-error/60" : ""}`}>
        <p className="label-mono text-[11px] text-muted">{D.undelivered}</p>
        <p className={`font-display mt-1 text-2xl font-extrabold ${cards.undelivered > 0 ? "text-error" : "text-foreground"}`}>
          {cards.undelivered}
        </p>
        <p className="mt-1 text-xs text-muted">{D.undeliveredHelp}</p>
      </div>
    </div>
  );
}
