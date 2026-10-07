"use client";

/**
 * Dashboard Home Page
 *
 * Overview cards, 7-day chart, and recent activity feed.
 */

import { useEffect, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import StatCard from "@/components/stat-card";
import LeadStatCards from "@/components/lead-stat-cards";
import StatusBadge from "@/components/status-badge";
import Skeleton from "@/components/skeleton";
import { useLanguage } from "@/components/language-provider";

interface DashboardStats {
  userName: string | null;
  contactsCount: number;
  totalAutomations: number;
  activeAutomations: number;
  dmsSentToday: number;
  dmsSentWeek: number;
  dmsSentMonth: number;
  dmsSkippedMonth: number;
  dmsFailedMonth: number;
  totalDMs: number;
  clicksThisMonth: number;
  totalClicks: number;
  ctrThisMonth: number;
  instagramAccounts: AccountOption[];
  selectedInstagramAccountId: string | null;
  topKeywords: { keyword: string; count: number }[];
  dailyDMs: { date: string; count: number }[];
  recentLogs: Array<{
    id: string;
    commenterName: string | null;
    commentText: string;
    status: string;
    createdAt: string;
    automation: { name: string };
    instagramAccount?: { username: string };
  }>;
}

export default function DashboardPage() {
  const { t } = useLanguage();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState("all");

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedAccountId !== "all") {
      params.set("instagramAccountId", selectedAccountId);
    }

    fetch(`/api/dashboard/stats${params.size ? `?${params}` : ""}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setStats(data.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedAccountId]);

  function handleAccountChange(accountId: string) {
    setLoading(true);
    setSelectedAccountId(accountId);
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="panel rounded-xl p-5 h-28">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-4 h-7 w-14" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-6 gap-4 sm:gap-6">
          <Skeleton className="h-64 rounded-xl lg:col-span-3" />
          <Skeleton className="h-64 rounded-xl lg:col-span-1" />
          <Skeleton className="h-64 rounded-xl lg:col-span-2" />
        </div>
      </div>
    );
  }

  const maxDM = Math.max(...(stats?.dailyDMs.map((d) => d.count) ?? [1]), 1);

  const connectedCount = stats?.instagramAccounts.length ?? 0;

  return (
    <div className="space-y-8">
      {/* Greeting header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="wrap-anywhere font-display text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
            {t.dashboard.greeting(stats?.userName ?? t.dashboard.guestName)}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {t.dashboard.connectedAccount(connectedCount)}
            {" · "}
            {t.dashboard.contact(stats?.contactsCount ?? 0)}
            {" · "}
            <a href="/logs" className="text-accent hover:underline">
              {t.dashboard.seeActivity}
            </a>
          </p>
        </div>
        {stats && stats.instagramAccounts.length > 1 && (
          <AccountSelect
            accounts={stats.instagramAccounts}
            value={selectedAccountId}
            onChange={handleAccountChange}
          />
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
        <StatCard
          label={t.dashboard.statActiveCampaigns}
          value={stats?.activeAutomations ?? 0}
        />
        <StatCard label={t.dashboard.statDmsSent} value={stats?.dmsSentMonth ?? 0} />
        <StatCard label={t.dashboard.statSkipped} value={stats?.dmsSkippedMonth ?? 0} />
        <StatCard label={t.dashboard.statFailed} value={stats?.dmsFailedMonth ?? 0} />
        <StatCard label={t.dashboard.statClicks} value={stats?.clicksThisMonth ?? 0} />
        <StatCard label={t.dashboard.statCtr} value={`${stats?.ctrThisMonth ?? 0}%`} />
      </div>

      <LeadStatCards />

      {/* Chart + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-6 gap-4 sm:gap-6">
        {/* 7-Day Chart */}
        <div className="lg:col-span-3 panel rounded-xl p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground mb-6">
            {t.dashboard.chartTitle}
          </h2>
          <div className="flex items-stretch gap-1.5 h-48 sm:gap-2">
            {stats?.dailyDMs.map((day) => (
              <div key={day.date} className="group min-w-0 flex-1 flex flex-col items-center gap-2">
                {/* The bar's % height needs a parent with a definite height:
                    this flex-1 track is the column minus the two labels. */}
                <div className="flex w-full flex-1 flex-col items-center justify-end gap-1.5">
                  <span className="text-xs text-muted font-medium tabular-nums group-hover:text-foreground">
                    {day.count}
                  </span>
                  <div
                    className="w-full rounded-t-md rounded-b-sm bg-gradient-to-t from-accent/40 to-accent min-h-[4px] opacity-90 transition-opacity group-hover:opacity-100"
                    style={{ height: `${Math.max((day.count / maxDM) * 80, 3)}%` }}
                  />
                </div>
                {/* Seven labels share a phone's width, so they must not wrap. */}
                <span className="w-full truncate text-center text-[10px] text-muted">
                  {day.date}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Top Keywords */}
        <div className="lg:col-span-1 panel rounded-xl p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">
            {t.dashboard.topKeywords}
          </h2>
          <div className="space-y-3">
            {stats?.topKeywords.length === 0 && (
              <p className="text-sm text-muted py-8">{t.dashboard.noKeywordMatches}</p>
            )}
            {stats?.topKeywords.map((keyword) => (
              <div key={keyword.keyword} className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-medium text-foreground">
                  {keyword.keyword}
                </span>
                <span className="text-xs text-muted">{keyword.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="lg:col-span-2 panel rounded-xl p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">
            {t.dashboard.recentActivity}
          </h2>
          {/* pr-2: without this, a status like "Yuborildi" sitting flush
              against the right edge gets its last characters covered by the
              scrollbar that appears once content exceeds max-h-60. */}
          <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
            {stats?.recentLogs.length === 0 && (
              <p className="text-sm text-muted text-center py-8">{t.dashboard.noActivity}</p>
            )}
            {stats?.recentLogs.map((log) => (
              <div
                key={log.id}
                className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">
                    @{log.commenterName ?? t.common.unknown}
                  </p>
                  <p className="text-xs text-muted truncate">
                    {log.instagramAccount
                      ? `@${log.instagramAccount.username} · `
                      : ""}
                    {log.commentText}
                  </p>
                </div>
                <StatusBadge status={log.status} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
