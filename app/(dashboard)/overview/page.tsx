"use client";

/**
 * Instagram Overview Page
 *
 * Aggregate reach/engagement across your recent posts, plus a per-post table.
 * Views / reach / saved / shares come from Instagram media insights (requires
 * the insights permission); likes and comments are always available.
 */

import { useEffect, useState } from "react";
import AccountSelect from "@/components/account-select";
import StatCard from "@/components/stat-card";
import FollowerChart from "@/components/follower-chart";
import { EmptyState, PageHeader } from "@/components/ui/page";
import type { OverviewResponse } from "@/app/api/instagram/overview/route";
import { useLanguage } from "@/components/language-provider";
import { formatShortMonthDay } from "@/lib/i18n/format-date";

function formatNumber(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export default function OverviewPage() {
  const { t, locale } = useLanguage();
  const formatDate = (iso: string) => formatShortMonthDay(new Date(iso), locale);
  const COUNT_OPTIONS = [
    { value: "25", label: t.overview.last25 },
    { value: "50", label: t.overview.last50 },
    { value: "100", label: t.overview.last100 },
    { value: "all", label: t.overview.allTimeOption },
  ];
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsConnect, setNeedsConnect] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [count, setCount] = useState("50");

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedAccountId !== "all") {
      params.set("instagramAccountId", selectedAccountId);
    }
    params.set("count", count);

    let cancelled = false;
    fetch(`/api/instagram/overview?${params}`)
      .then((r) => r.json())
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setData(res.data);
          setError(null);
        } else {
          // Server messages are English-only; show the localized text and
          // keep the connect link when the account isn't connected.
          setNeedsConnect(String(res.error ?? "").toLowerCase().includes("connect"));
          setError(t.overview.failedToLoad);
        }
      })
      .catch(() => {
        if (!cancelled) setError(t.overview.failedToLoad);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId, count, t]);

  function handleAccountChange(accountId: string) {
    setLoading(true);
    setSelectedAccountId(accountId);
  }

  function handleCountChange(next: string) {
    setLoading(true);
    setCount(next);
  }

  if (loading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="panel h-24 animate-pulse rounded-2xl p-4 sm:p-5">
            <div className="h-4 w-16 rounded-full bg-surface-hover" />
            <div className="mt-3 h-6 w-20 rounded-full bg-surface-hover/60" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel rounded-3xl p-8 text-center">
        <p className="text-sm text-error">{error}</p>
        {needsConnect && (
          <a href="/api/instagram/connect" className="btn btn-sm btn-primary mt-4">
            {t.overview.connectInstagram}
          </a>
        )}
      </div>
    );
  }

  if (!data) return null;

  const { totals, posts, accounts, insightsAvailable, followers, followerHistory } =
    data;

  return (
    <div className="space-y-6">
      <PageHeader
        description={
          <>
            {data.requestedCount === "all" ? t.overview.allTime : t.overview.recent} —{" "}
            {t.overview.postCount(totals.posts)} from @{data.account.username}
            {data.truncated ? t.overview.cappedAt(totals.posts) : ""}
            {followers !== null && (
              // Kept out of the tile row below: that row sums the selected posts,
              // whereas this is a current account-level total.
              <span className="mt-1 block">
                {t.overview.followersCount(followers.toLocaleString())}
              </span>
            )}
          </>
        }
        actions={
          <>
            <label className="flex flex-col gap-2 text-sm">
              <span className="text-xs font-semibold text-muted">{t.overview.range}</span>
              <select
                value={count}
                onChange={(e) => handleCountChange(e.target.value)}
                className="input !w-auto"
              >
                {COUNT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {accounts.length > 1 && (
              <AccountSelect
                accounts={accounts.map((a) => ({
                  id: a.id,
                  username: a.username,
                  instagramId: a.id,
                }))}
                value={selectedAccountId}
                onChange={handleAccountChange}
              />
            )}
          </>
        }
      />

      {!insightsAvailable && (
        <div className="panel rounded-3xl p-5 sm:p-6">
          <p className="text-sm font-semibold text-white">{t.overview.insightsNeeded}</p>
          <p className="mt-1 text-sm leading-6 text-muted">{t.overview.insightsNeededBody}</p>
          <a href="/api/instagram/connect" className="btn btn-sm btn-primary mt-4">
            {t.overview.reconnectInstagram}
          </a>
        </div>
      )}

      {/* Aggregate totals */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        <StatCard label={t.overview.views} value={formatNumber(totals.views)} />
        <StatCard label={t.overview.reach} value={formatNumber(totals.reach)} />
        <StatCard label={t.overview.likes} value={formatNumber(totals.likes)} />
        <StatCard label={t.overview.comments} value={formatNumber(totals.comments)} />
        <StatCard label={t.overview.saved} value={formatNumber(totals.saved)} />
        <StatCard label={t.overview.shares} value={formatNumber(totals.shares)} />
      </div>

      {/* Follower trend — account-level, independent of the post range */}
      <FollowerChart data={followerHistory} followers={followers} />

      {/* Per-post table */}
      <div className="panel rounded-3xl p-5 sm:p-6">
        <h2 className="mb-5 text-base font-bold text-white">
          {t.overview.postsTableTitle}
        </h2>
        {posts.length === 0 ? (
          <EmptyState title={t.overview.noPostsFound} />
        ) : (
          // Eight metric columns can't compress into a phone; let the table keep
          // its natural width and scroll inside the panel instead.
          <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-muted">
                  <th className="py-2 pr-4 font-semibold">{t.overview.colPost}</th>
                  <th className="py-2 px-3 font-semibold text-right">{t.overview.views}</th>
                  <th className="py-2 px-3 font-semibold text-right">{t.overview.reach}</th>
                  <th className="py-2 px-3 font-semibold text-right">{t.overview.likes}</th>
                  <th className="py-2 px-3 font-semibold text-right">{t.overview.comments}</th>
                  <th className="py-2 px-3 font-semibold text-right">{t.overview.saved}</th>
                  <th className="py-2 px-3 font-semibold text-right">{t.overview.shares}</th>
                  <th className="py-2 pl-3 font-semibold text-right">{t.overview.colDate}</th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-midnight/40">
                {posts.map((p) => (
                  <tr key={p.id}>
                    <td className="py-3 pr-4 max-w-xs">
                      {p.permalink ? (
                        <a
                          href={p.permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-white hover:text-lime truncate block"
                        >
                          {p.caption || `${p.mediaType} post`}
                        </a>
                      ) : (
                        <span className="text-white truncate block">
                          {p.caption || `${p.mediaType} post`}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right text-muted">
                      {formatNumber(p.views)}
                    </td>
                    <td className="py-3 px-3 text-right text-muted">
                      {formatNumber(p.reach)}
                    </td>
                    <td className="py-3 px-3 text-right text-muted">
                      {formatNumber(p.likes)}
                    </td>
                    <td className="py-3 px-3 text-right text-muted">
                      {formatNumber(p.comments)}
                    </td>
                    <td className="py-3 px-3 text-right text-muted">
                      {formatNumber(p.saved)}
                    </td>
                    <td className="py-3 px-3 text-right text-muted">
                      {formatNumber(p.shares)}
                    </td>
                    <td className="py-3 pl-3 text-right text-muted">
                      {formatDate(p.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
