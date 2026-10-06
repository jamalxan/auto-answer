"use client";

/**
 * Per-thread assistant strip for the inbox: who is answering (assistant /
 * operator / lead captured), the "stop / resume the bot" switch, and the lead
 * details with CRM links.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/assistant-ui";
import { useLanguage } from "@/components/language-provider";
import { formatShortMonthDayTime } from "@/lib/i18n/format-date";

interface InboxState {
  canManage: boolean;
  conversation: {
    id: string;
    assistantState: string;
    botPaused: boolean;
    operatorActive: boolean;
    operatorActiveUntil: string | null;
    badge: "assistant" | "operator" | "lead";
    collected: { name: string | null; phone: string | null; productInterest: string | null };
  } | null;
  lead: {
    id: string;
    name: string | null;
    phoneE164: string | null;
    productInterest: string | null;
    campaignName: string | null;
    flag: string | null;
    crmLinks: Array<{ type: "AMOCRM" | "BITRIX24" | "TELEGRAM"; url: string }>;
  } | null;
}

export default function InboxAssistantBar({
  accountId,
  contactId,
}: {
  accountId: string;
  contactId: string;
}) {
  const { t, locale } = useLanguage();
  const I = t.assistant.inbox;
  const [state, setState] = useState<InboxState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accountId || !contactId) return;
    try {
      const res = await fetch(
        `/api/assistant/inbox-state?instagramAccountId=${accountId}&contactId=${contactId}`,
        { cache: "no-store" }
      );
      const payload = await res.json();
      if (payload.success) setState(payload.data);
    } catch {
      // The strip is informational; a failed fetch just hides it.
    }
  }, [accountId, contactId]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  async function toggle(action: "pause" | "resume") {
    if (!state?.conversation) return;
    setBusy(true);
    await fetch(`/api/conversations/${state.conversation.id}/assistant/${action}`, { method: "POST" });
    await load();
    setBusy(false);
  }

  const conversation = state?.conversation;
  if (!conversation) return null;

  const lead = state?.lead;
  const stopped = conversation.botPaused || conversation.operatorActive;
  const badge =
    conversation.badge === "lead"
      ? { tone: "success" as const, text: I.badgeLead }
      : conversation.badge === "operator"
        ? { tone: "warning" as const, text: I.badgeOperator }
        : { tone: "accent" as const, text: I.badgeAssistant };

  const name = lead?.name ?? conversation.collected.name;
  const phone = lead?.phoneE164 ?? conversation.collected.phone;
  const interest = lead?.productInterest ?? conversation.collected.productInterest;

  return (
    <div className="shrink-0 border-b border-border bg-surface/60 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone}>{badge.text}</Badge>
        {conversation.botPaused && <span className="text-xs text-muted">{I.pausedNote}</span>}
        {!conversation.botPaused && conversation.operatorActive && conversation.operatorActiveUntil && (
          <span className="text-xs text-muted">
            {I.operatorUntil(formatShortMonthDayTime(new Date(conversation.operatorActiveUntil), locale))}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {(name || phone || interest) && (
            <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs font-medium text-accent hover:underline">
              {I.leadPanel}
            </button>
          )}
          {state?.canManage && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void toggle(stopped ? "resume" : "pause")}
              className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-surface-hover disabled:opacity-50"
            >
              {stopped ? I.resume : I.pause}
            </button>
          )}
        </div>
      </div>

      {open && (
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted">{I.name}</dt>
            <dd className="text-foreground">{name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted">{I.phone}</dt>
            <dd className="font-mono text-foreground">{phone ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted">{I.interest}</dt>
            <dd className="text-foreground">{interest ?? "—"}</dd>
          </div>
          {lead?.campaignName && (
            <div>
              <dt className="text-muted">{I.campaign}</dt>
              <dd className="text-foreground">{lead.campaignName}</dd>
            </div>
          )}
          {lead && lead.crmLinks.length > 0 && (
            <div className="sm:col-span-2">
              <dt className="text-muted">{I.crm}</dt>
              <dd className="flex flex-wrap gap-3">
                {lead.crmLinks.map((link) => (
                  <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
                    {link.type === "AMOCRM" ? "amoCRM" : "Bitrix24"} ↗
                  </a>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
