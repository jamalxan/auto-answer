"use client";

/**
 * Campaigns List Page
 *
 * Shows all campaigns as cards with toggle and delete.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { readCache, writeCache } from "@/lib/client-cache";
import { useLanguage } from "@/components/language-provider";
import { Card, EmptyState, PageHeader } from "@/components/ui/page";

interface Campaign {
  id: string;
  name: string;
  goal: string | null;
  postId: string | null;
  postUrl: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  dmMessage: string;
  openingDmEnabled: boolean;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  publicReplyEnabled: boolean;
  publicReplyMessage: string | null;
  publicReplyMessages: string[];
  requireFollow: boolean;
  followPromptMessage: string | null;
  followPromptButtonLabel: string | null;
  isActive: boolean;
  wholeWordMatch: boolean;
  instagramAccountId: string;
  instagramAccount: {
    username: string;
    instagramId: string;
  };
  reportShareSlug: string | null;
  reportShareEnabled: boolean;
  reportUrl: string | null;
  createdAt: string;
  _count: { dmLogs: number };
  trackedLinks: Array<{
    id: string;
    slug: string;
    label: string | null;
    destinationUrl: string;
    trackedUrl: string;
    _count: { clicks: number };
  }>;
  analytics: {
    sent: number;
    skipped: number;
    failed: number;
    clicks: number;
    ctr: number;
    topKeywords: { keyword: string; count: number }[];
  };
}

export default function CampaignsPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const [automations, setAutomations] = useState<Campaign[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [loading, setLoading] = useState(true);
  // postId -> current thumbnail URL, fetched live (Instagram URLs expire, so
  // they are never stored on the campaign).
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  // postId -> video URL for reels, so a campaign thumbnail can play on click.
  const [videos, setVideos] = useState<Record<string, string>>({});
  // The reel currently playing in the lightbox (null when closed).
  const [playingVideo, setPlayingVideo] = useState<{
    url: string;
    postUrl: string | null;
  } | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">(
    "all"
  );

  // Only the newest list request may apply (account switches mid-flight).
  const fetchSeq = useRef(0);
  const fetchAutomations = useCallback(async () => {
    const seq = ++fetchSeq.current;
    try {
      const params = new URLSearchParams();
      if (selectedAccountId !== "all") {
        params.set("instagramAccountId", selectedAccountId);
      }
      const res = await fetch(
        `/api/automations${params.size ? `?${params}` : ""}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (seq !== fetchSeq.current) return;
      if (data.success) setAutomations(data.data);
    } catch (err) {
      console.error("Failed to fetch campaigns:", err);
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [selectedAccountId]);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) setAccounts(payload.data.instagramAccounts ?? []);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAutomations();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchAutomations]);

  // Fetch fresh post thumbnails (and reel video URLs) for the accounts in view
  // and map them by postId. Cache-first so they show instantly on a return
  // visit. Instagram URLs expire, so they are never stored on the campaign.
  // Keyed on the account ids only, so toggling or editing a campaign doesn't
  // refetch every post library.
  const mediaAccountKey = Array.from(
    new Set(automations.map((a) => a.instagramAccountId))
  )
    .sort()
    .join(",");
  useEffect(() => {
    if (!mediaAccountKey) return;
    let cancelled = false;
    const accountIds = mediaAccountKey.split(",");
    const cacheKey = `ig-media:${accountIds.join(",")}`;

    const cached = readCache<{
      thumbs: Record<string, string>;
      videos: Record<string, string>;
    }>(cacheKey, 15 * 60 * 1000);
    // Hydrating state from cache is a legitimate effect use here.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (cached.data) {
      setThumbnails(cached.data.thumbs);
      setVideos(cached.data.videos);
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    Promise.all(
      accountIds.map((accountId) =>
        fetch(`/api/instagram/posts?instagramAccountId=${accountId}&limit=50`)
          .then((res) => res.json())
          .then((payload) =>
            payload.success
              ? (payload.data as {
                  id: string;
                  media_type?: string;
                  media_url?: string;
                  thumbnail_url?: string;
                }[])
              : []
          )
          .catch(() => [])
      )
    ).then((lists) => {
      if (cancelled) return;
      const thumbs: Record<string, string> = {};
      const vids: Record<string, string> = {};
      for (const list of lists) {
        for (const media of list) {
          const url = media.thumbnail_url ?? media.media_url;
          if (url) thumbs[media.id] = url;
          if (media.media_type === "VIDEO" && media.media_url) {
            vids[media.id] = media.media_url;
          }
        }
      }
      setThumbnails(thumbs);
      setVideos(vids);
      writeCache(cacheKey, { thumbs, videos: vids });
    });

    return () => {
      cancelled = true;
    };
  }, [mediaAccountKey]);

  // Close the reel lightbox on Escape.
  useEffect(() => {
    if (!playingVideo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlayingVideo(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playingVideo]);

  function handleAccountChange(accountId: string) {
    setLoading(true);
    setSelectedAccountId(accountId);
  }

  async function toggleActive(id: string, isActive: boolean) {
    try {
      await fetch(`/api/automations?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !isActive }),
      });
      setAutomations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, isActive: !isActive } : a))
      );
    } catch (err) {
      console.error("Failed to toggle:", err);
    }
  }

  async function copyReelUrl(auto: Campaign) {
    setMenuOpenId(null);
    if (!auto.postUrl) return;
    try {
      await navigator.clipboard.writeText(auto.postUrl);
      setCopiedId(auto.id);
      window.setTimeout(
        () => setCopiedId((cur) => (cur === auto.id ? null : cur)),
        1500
      );
    } catch (err) {
      console.error("Failed to copy reel URL:", err);
    }
  }

  async function deleteAutomation(id: string) {
    if (!confirm(t.campaigns.confirmDelete)) return;
    try {
      await fetch(`/api/automations?id=${id}`, { method: "DELETE" });
      setAutomations((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  }

  // The copy is made server-side from the stored campaign, so settings this
  // list never loads (the DM trigger, the follow-up, the link button label)
  // still come along.
  async function duplicateAutomation(id: string) {
    setMenuOpenId(null);
    try {
      const res = await fetch(`/api/automations/duplicate?id=${id}`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) void fetchAutomations();
      else console.error("Duplicate failed:", data.error);
    } catch (err) {
      console.error("Failed to duplicate:", err);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="panel h-36 animate-pulse rounded-3xl" />
        ))}
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const filtered = automations.filter((a) => {
    if (statusFilter === "active" && !a.isActive) return false;
    if (statusFilter === "paused" && a.isActive) return false;
    if (!query) return true;
    return (
      a.name.toLowerCase().includes(query) ||
      a.keywords.some((k) => k.toLowerCase().includes(query)) ||
      a.dmMessage.toLowerCase().includes(query)
    );
  });

  return (
    <div className="space-y-6">
      {/* Header: the top bar carries the section title, so only the count
          and the page actions live here. */}
      <PageHeader
        description={
          <>
            {filtered.length !== automations.length
              ? `${filtered.length} / `
              : ""}
            {t.campaigns.campaignCount(automations.length)}
          </>
        }
        actions={
          <>
            {accounts.length > 1 && (
              <AccountSelect
                accounts={accounts}
                value={selectedAccountId}
                onChange={handleAccountChange}
              />
            )}
            <Link href="/campaigns/import" className="btn btn-sm btn-ghost">
              {t.campaigns.importButton}
            </Link>
            <Link href="/campaigns/new" className="btn btn-sm btn-lime">
              {t.campaigns.newCampaignButton}
            </Link>
          </>
        }
      />

      {/* Search + status filter */}
      {automations.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.campaigns.searchPlaceholder}
            className="input"
          />
          <div className="flex shrink-0 flex-wrap gap-2">
            {(["all", "active", "paused"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`chip ${statusFilter === s ? "chip-active" : ""}`}
              >
                {s === "all"
                  ? t.campaigns.filterAll
                  : s === "active"
                    ? t.campaigns.filterActive
                    : t.campaigns.filterPaused}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {automations.length === 0 && (
        <Card>
          <EmptyState
            title={t.campaigns.noCampaignsYet}
            body={t.campaigns.noCampaignsBody}
            action={
              <Link href="/campaigns/new" className="btn btn-lime">
                {t.campaigns.createCampaignButton}
              </Link>
            }
          />
        </Card>
      )}

      {/* No matches for the current filter */}
      {automations.length > 0 && filtered.length === 0 && (
        <Card>
          <EmptyState title={t.campaigns.noMatches} />
        </Card>
      )}

      {/* Campaign cards */}
      <div className="space-y-3">
        {filtered.map((auto) => {
          const videoUrl = auto.postId ? videos[auto.postId] : undefined;
          return (
          <div
            key={auto.id}
            onClick={() => router.push(`/campaigns/${auto.id}`)}
            className="panel cursor-pointer rounded-3xl p-5 transition-colors hover:bg-surface-hover sm:p-6"
          >
            {/* Wraps rather than compressing: on a phone the action buttons drop
                to their own line instead of squeezing the campaign summary. */}
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
              {auto.postId && thumbnails[auto.postId] && (
                videoUrl ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPlayingVideo({ url: videoUrl, postUrl: auto.postUrl });
                    }}
                    aria-label="Play reel preview"
                    className="shrink-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumbnails[auto.postId]}
                      alt="Campaign reel"
                      className="h-12 w-12 rounded-xl object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  </button>
                ) : (
                  <a
                    href={auto.postUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumbnails[auto.postId]}
                      alt="Campaign post"
                      className="h-12 w-12 rounded-xl object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  </a>
                )
              )}
              <div className="min-w-[12rem] flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-white">{auto.name}</h3>
                  <span className="shrink-0 rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-muted">
                    @{auto.instagramAccount.username}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      auto.isActive
                        ? "bg-lime/15 text-lime"
                        : "bg-white/10 text-muted"
                    }`}
                  >
                    {auto.isActive ? t.campaigns.active : t.campaigns.paused}
                  </span>
                  {auto.pendingNextReel && (
                    <span className="shrink-0 rounded-full bg-warning/15 px-2.5 py-0.5 text-xs font-semibold text-warning">
                      {t.campaigns.waitingForNextReel}
                    </span>
                  )}
                  {auto.requireFollow && (
                    <span className="shrink-0 rounded-full bg-violet/25 px-2.5 py-0.5 text-xs font-semibold text-white">
                      {t.campaigns.followGate}
                    </span>
                  )}
                  {auto.trackedLinks.length >= 2 && (
                    <span className="shrink-0 rounded-full bg-violet/25 px-2.5 py-0.5 text-xs font-semibold text-white">
                      {t.campaigns.twoLinks}
                    </span>
                  )}
                </div>

                {/* Keywords */}
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {auto.keywords.map((kw) => (
                    <span
                      key={kw}
                      className="rounded-full bg-lime/12 px-2.5 py-0.5 text-xs font-semibold text-lime"
                    >
                      {kw}
                    </span>
                  ))}
                </div>

                {/* DM preview */}
                <p className="truncate text-sm text-muted">&ldquo;{auto.dmMessage}&rdquo;</p>

                {/* Tracked link sent */}
                {auto.trackedLinks[0]?.trackedUrl && (
                  <p className="mt-2 truncate text-xs text-muted">
                    {auto.trackedLinks[0].trackedUrl}
                  </p>
                )}

                {/* Stats */}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
                  <span className="font-medium text-white">
                    {t.campaigns.runs(auto._count.dmLogs)}
                  </span>
                  <span>·</span>
                  <span className="font-medium text-white">
                    {t.campaigns.ctr(String(auto.analytics.ctr))}
                  </span>
                  <span>·</span>
                  <span>{t.campaigns.sent(auto.analytics.sent)}</span>
                  <span>·</span>
                  <span>{t.campaigns.skipped(auto.analytics.skipped)}</span>
                  <span>·</span>
                  <span>{t.campaigns.failed(auto.analytics.failed)}</span>
                  <span>·</span>
                  <span>{t.campaigns.clicks(auto.analytics.clicks)}</span>
                </div>

                {auto.analytics.topKeywords.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {auto.analytics.topKeywords.map((keyword) => (
                      <span
                        key={keyword.keyword}
                        className="rounded-full bg-midnight px-2.5 py-1 text-xs text-muted"
                      >
                        {keyword.keyword}: {keyword.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div
                className="ml-auto flex items-center gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Copy reel URL */}
                {auto.postUrl && (
                  <button
                    onClick={() => void copyReelUrl(auto)}
                    className="btn btn-sm btn-ghost shrink-0"
                  >
                    {copiedId === auto.id ? t.campaigns.copied : t.campaigns.copyUrl}
                  </button>
                )}
                {/* Toggle */}
                <button
                  onClick={() => toggleActive(auto.id, auto.isActive)}
                  className={`
                    relative h-6 w-11 rounded-full transition-colors
                    ${auto.isActive ? "bg-violet" : "bg-white/15"}
                  `}
                >
                  <span
                    className={`
                      absolute top-1 h-4 w-4 rounded-full bg-white transition-transform
                      ${auto.isActive ? "left-6" : "left-1"}
                    `}
                  />
                </button>

                {/* Kebab menu */}
                <div className="relative">
                  <button
                    onClick={() =>
                      setMenuOpenId((cur) => (cur === auto.id ? null : auto.id))
                    }
                    aria-label="More actions"
                    className="grid h-9 w-9 place-items-center rounded-full text-lg leading-none text-muted hover:bg-surface-hover hover:text-white"
                  >
                    ⋯
                  </button>
                  {menuOpenId === auto.id && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setMenuOpenId(null)}
                      />
                      <div className="panel absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-2xl p-1.5 shadow-float">
                        <button
                          onClick={() => void duplicateAutomation(auto.id)}
                          className="block w-full rounded-xl px-3 py-2 text-left text-sm text-white hover:bg-surface-hover"
                        >
                          {t.campaigns.duplicate}
                        </button>
                        <button
                          onClick={() => {
                            setMenuOpenId(null);
                            void deleteAutomation(auto.id);
                          }}
                          className="block w-full rounded-xl px-3 py-2 text-left text-sm text-error hover:bg-surface-hover"
                        >
                          {t.campaigns.delete}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          );
        })}
      </div>

      {/* Reel lightbox */}
      {playingVideo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-midnight/75 p-4"
          onClick={() => setPlayingVideo(null)}
        >
          <div
            className="relative flex max-w-full flex-col items-end gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              {playingVideo.postUrl && (
                <a
                  href={playingVideo.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-sm btn-ghost"
                >
                  Open on Instagram
                </a>
              )}
              <button
                type="button"
                onClick={() => setPlayingVideo(null)}
                className="btn btn-sm btn-ghost"
              >
                Close
              </button>
            </div>
            <video
              src={playingVideo.url}
              controls
              autoPlay
              loop
              playsInline
              className="max-h-[80vh] max-w-full rounded-2xl shadow-float"
            />
          </div>
        </div>
      )}
    </div>
  );
}
