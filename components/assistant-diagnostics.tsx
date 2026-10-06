"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/assistant-ui";
import { useLanguage } from "@/components/language-provider";
import { formatShortMonthDayTime } from "@/lib/i18n/format-date";

interface Overview {
  deliveryErrors: Array<{
    id: string;
    leadId: string;
    status: "DEAD" | "FAILED";
    attempts: number;
    lastError: string | null;
    updatedAt: string;
    integration: string;
    leadName: string | null;
  }>;
  integrations: Array<{
    id: string;
    name: string;
    type: string;
    status: "ACTIVE" | "BROKEN" | "DISABLED";
    lastError: string | null;
    lastCheckedAt: string | null;
  }>;
  llm: {
    configured: boolean;
    errors7d: number;
    blocked7d: number;
    templateOnlyUntil: string | null;
    aiUsed: number;
    aiLimit: number;
    costUsd30: string;
  };
}

const TONE = { ACTIVE: "success", BROKEN: "error", DISABLED: "muted" } as const;

/** Diagnostics: lead delivery errors, integration health, LLM / fallback mode. */
export default function AssistantDiagnostics() {
  const { t, locale } = useLanguage();
  const D = t.assistant.diagnostics;
  const [data, setData] = useState<Overview | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/assistant/overview", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (!cancelled && payload.success) setData(payload.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) return null;
  const when = (value: string) => formatShortMonthDayTime(new Date(value), locale);

  return (
    <>
      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">{D.deliveryErrors}</h2>
        {data.deliveryErrors.length === 0 ? (
          <p className="py-5 text-center text-sm text-muted">{D.deliveryErrorsEmpty}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {data.deliveryErrors.map((d) => (
              <li key={d.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-foreground">
                    {d.integration} · {d.leadName ?? "—"}
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone={d.status === "DEAD" ? "error" : "warning"}>{t.assistant.leads.delivery[d.status === "DEAD" ? "DEAD" : "FAILED"]}</Badge>
                    <span className="text-xs text-muted">{when(d.updatedAt)}</span>
                  </span>
                </div>
                {d.lastError && <p className="mt-1 break-words text-xs text-error">{d.lastError}</p>}
                <Link href="/leads" className="mt-1 inline-block text-xs font-medium text-accent hover:underline">
                  {t.assistant.nav.leads}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">{D.integrationHealth}</h2>
        {data.integrations.length === 0 ? (
          <p className="py-5 text-center text-sm text-muted">{D.integrationHealthEmpty}</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {data.integrations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="text-foreground">{i.name}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={TONE[i.status]}>{t.assistant.integrations.status[i.status]}</Badge>
                  {i.lastCheckedAt && <span className="text-xs text-muted">{when(i.lastCheckedAt)}</span>}
                </span>
                {i.lastError && i.status !== "ACTIVE" && <p className="w-full break-words text-xs text-error">{i.lastError}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold text-foreground">{D.llmHealth}</h2>
        <ul className="mt-3 space-y-2 text-sm text-foreground">
          <li>
            {!data.llm.configured ? (
              <Badge tone="error">{D.llmNotConfigured}</Badge>
            ) : data.llm.templateOnlyUntil ? (
              <Badge tone="warning">{D.templateMode(when(data.llm.templateOnlyUntil))}</Badge>
            ) : (
              <Badge tone="success">{D.llmOk}</Badge>
            )}
          </li>
          <li className="text-muted">{D.llmErrors(data.llm.errors7d)}</li>
          <li className="text-muted">{D.blockedReplies(data.llm.blocked7d)}</li>
          <li className="text-muted">{D.aiUsage(data.llm.aiUsed, data.llm.aiLimit)}</li>
          <li className="text-muted">{D.cost(data.llm.costUsd30)}</li>
        </ul>
      </section>
    </>
  );
}
