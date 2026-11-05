"use client";

/**
 * Umumiy ko'rinish: "Umumiy" (every network side by side) plus one tab per
 * network with its own detail (Instagram keeps its insights page; Facebook,
 * Threads, YouTube and Telegram get NetworkDetail). The view, range and
 * account live in the URL (?n=&days=&account=) so a detail is linkable and
 * the back button works.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { BrandIcon } from "@/components/brand-icons";
import { NETWORK_NAME } from "@/components/channels/ui";
import type { StatsNetwork } from "@/lib/analytics/network-stats";
import InstagramOverview from "./instagram-overview";
import NetworkDetailView from "./network-detail";
import NetworkStatsView from "./network-stats";
import { RANGES, type Range } from "./format";

const NETWORKS: StatsNetwork[] = ["instagram", "facebook", "threads", "youtube", "telegram"];
type View = "all" | StatsNetwork;

export default function OverviewDashboard() {
  const router = useRouter();
  const params = useSearchParams();
  const rawView = params.get("n");
  const view: View = NETWORKS.includes(rawView as StatsNetwork) ? (rawView as StatsNetwork) : "all";
  const rawDays = Number(params.get("days"));
  const days: Range = (RANGES as readonly number[]).includes(rawDays) ? (rawDays as Range) : 30;
  const account = params.get("account");

  const go = (next: { view?: View; days?: Range; account?: string | null }) => {
    const v = next.view ?? view;
    const q = new URLSearchParams();
    if (v !== "all") q.set("n", v);
    const d = next.days ?? days;
    if (d !== 30) q.set("days", String(d));
    const a = next.account === undefined ? (next.view && next.view !== view ? null : account) : next.account;
    if (a && v !== "all") q.set("account", a);
    const qs = q.toString();
    router.push(qs ? `/overview?${qs}` : "/overview", { scroll: false });
  };

  return (
    <div className="space-y-6">
      <nav className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Tarmoq bo'yicha statistika">
        <SwitchTab active={view === "all"} onClick={() => go({ view: "all" })}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="currentColor">
            <rect x="3" y="3" width="8" height="8" rx="2" />
            <rect x="13" y="3" width="8" height="8" rx="2" opacity=".6" />
            <rect x="3" y="13" width="8" height="8" rx="2" opacity=".6" />
            <rect x="13" y="13" width="8" height="8" rx="2" opacity=".35" />
          </svg>
          Umumiy
        </SwitchTab>
        {NETWORKS.map((n) => (
          <SwitchTab key={n} active={view === n} onClick={() => go({ view: n })}>
            <BrandIcon brand={n} className="h-4 w-4" />
            {NETWORK_NAME[n]}
          </SwitchTab>
        ))}
      </nav>

      {view === "all" ? (
        <NetworkStatsView days={days} onDays={(d) => go({ days: d })} onOpen={(n, a) => go({ view: n, account: a ?? null })} />
      ) : view === "instagram" ? (
        <InstagramOverview key={account ?? "all"} initialAccountId={account ?? "all"} />
      ) : (
        <NetworkDetailView key={view} network={view} days={days} accountId={account} onDays={(d) => go({ days: d })} onAccount={(a) => go({ account: a })} />
      )}
    </div>
  );
}

function SwitchTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime ${
        // Dark in both states so every logo (Threads is white) keeps its colour; the lime ring marks the active one.
        active ? "bg-surface-hover text-white ring-1 ring-inset ring-lime/70" : "bg-surface text-muted hover:bg-surface-hover hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
