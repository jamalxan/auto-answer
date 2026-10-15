"use client";

/** One Comment 2.0 campaign: builder and logs, as tabs (?tab=logs). */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DevBadge, Pill } from "@/components/developer/ui";
import CommentBuilder from "./comment-builder";
import CommentLogs from "./comment-logs";
import type { Account, CommentCampaignView, IntentOption } from "./shared";

const TABS = [
  ["settings", "Sozlash"],
  ["logs", "Loglar"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function CampaignDetail({
  campaign,
  accounts,
  intents,
  initialTab,
}: {
  campaign: CommentCampaignView;
  accounts: Account[];
  intents: IntentOption[];
  initialTab: Tab;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);

  function select(next: Tab) {
    setTab(next);
    router.replace(`/developer/comments/${campaign.id}${next === "logs" ? "?tab=logs" : ""}`, { scroll: false });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <Link href="/developer/comments" className="text-sm text-muted hover:text-foreground">
          ← Comment Automation 2.0
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="break-words font-display text-2xl font-extrabold tracking-tight text-foreground">{campaign.name}</h1>
          <Pill tone={campaign.active ? "success" : "muted"}>{campaign.active ? "Faol" : "O'chiq"}</Pill>
          {campaign.triggerType === "LIVE_COMMENT" && (
            <span className="label-mono rounded-md bg-error/10 px-1.5 py-0.5 text-[10px] font-bold text-error">LIVE</span>
          )}
          <DevBadge />
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => select(key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
              tab === key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* The builder stays mounted so switching to the logs never loses unsaved edits. */}
      <div hidden={tab !== "settings"}>
        <CommentBuilder accounts={accounts} intents={intents} campaign={campaign} />
      </div>
      {tab === "logs" && <CommentLogs campaignId={campaign.id} />}
    </div>
  );
}
