"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Post Picker
 *
 * Grid of Instagram post thumbnails, selectable.
 * Fetches from /api/instagram/posts.
 */

import { useEffect, useState } from "react";
import { readCache, writeCache } from "@/lib/client-cache";
import { useLanguage } from "@/components/language-provider";

const PAGE_SIZE = 60;

interface InstagramPost {
  id: string;
  caption?: string;
  media_type: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp: string;
}

interface PostPickerProps {
  selectedPostId: string | null;
  instagramAccountId?: string | null;
  /** postId -> name of the campaign already using it. Flagged in the grid. */
  usedPostIds?: Record<string, string>;
  onSelect: (
    postId: string,
    postUrl?: string,
    thumbUrl?: string,
    caption?: string
  ) => void;
}

export default function PostPicker({
  selectedPostId,
  instagramAccountId,
  usedPostIds,
  onSelect,
}: PostPickerProps) {
  const { t } = useLanguage();
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The post currently hovered — its video (if it's a reel) plays a preview.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Instagram's CDN thumbnail URLs expire; a post whose URL has already
  // lapsed by the time this grid renders was showing a broken-image icon on
  // a bare (no background) tile with nothing to say why. Tracked so it falls
  // back to the same "no image" placeholder as a post with no thumb at all.
  const [failedThumbIds, setFailedThumbIds] = useState<Set<string>>(new Set());
  // The grid loads the whole library (all=true). On accounts with hundreds of
  // posts, rendering every tile at once is enough to make mobile Safari drop
  // the page, so they are revealed in batches.
  const [shown, setShown] = useState(PAGE_SIZE);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (instagramAccountId) {
      params.set("instagramAccountId", instagramAccountId);
    }
    // Load the full library so older posts/reels are selectable, not just the
    // most recent page.
    params.set("all", "true");

    // Show the cached library instantly (stale-while-revalidate), then refresh.
    const cacheKey = `ig-posts:${instagramAccountId ?? "default"}`;
    const cached = readCache<InstagramPost[]>(cacheKey, 15 * 60 * 1000);
    // Hydrating state from cache is a legitimate effect use here.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (cached.data) {
      setPosts(cached.data);
      setLoading(false);
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    fetch(`/api/instagram/posts${params.size ? `?${params}` : ""}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) {
          setPosts(data.data);
          writeCache(cacheKey, data.data);
        } else if (!cached.data) {
          setError(data.error ?? t.postPicker.errorFailedToLoad);
        }
      })
      .catch(() => {
        if (!cancelled && !cached.data) setError(t.postPicker.errorFailedToLoad);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [instagramAccountId, t]);

  if (loading) {
    return (
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="aspect-square rounded bg-surface" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted">{error}</p>
        <p className="text-xs text-muted mt-1">{t.postPicker.connectFirst}</p>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted">{t.postPicker.noPostsFound}</p>
      </div>
    );
  }

  const matching = query.trim()
    ? posts.filter((p) =>
        (p.caption ?? "").toLowerCase().includes(query.trim().toLowerCase())
      )
    : posts;

  const visible = matching.slice(0, shown);
  const remaining = matching.length - visible.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Back to one batch on every new search. Without this, a grid
            // expanded under an earlier query stays expanded once it is
            // cleared, which is the case this whole change exists to avoid.
            setShown(PAGE_SIZE);
          }}
          placeholder={t.postPicker.searchPlaceholder}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent/40 focus:outline-none"
        />
        <span className="shrink-0 text-xs text-muted">{posts.length}</span>
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          {t.postPicker.noPostsMatch(query)}
        </p>
      ) : (
        <>
          {usedPostIds && Object.keys(usedPostIds).length > 0 && (
            <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border border-warning/50" />
              {t.postPicker.alreadyUsed}
            </p>
          )}
          {/* auto-rows-min + content-start keep each row at its natural height.
              Without them the rows share out max-h-64 instead of scrolling, and
              the square thumbnails flatten into strips. */}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-64 auto-rows-min content-start overflow-y-auto p-1">
            {visible.map((post) => {
              const isSelected = selectedPostId === post.id;
              const usedByName = usedPostIds?.[post.id];
              const isUsed = Boolean(usedByName) && !isSelected;
              const thumb = failedThumbIds.has(post.id)
                ? undefined
                : post.thumbnail_url ?? post.media_url;
              const isVideo = post.media_type === "VIDEO";
              const showVideo =
                isVideo && hoveredId === post.id && Boolean(post.media_url);
              return (
          <button
            key={post.id}
            type="button"
            onClick={() => onSelect(post.id, post.permalink, thumb, post.caption)}
            onMouseEnter={() => setHoveredId(post.id)}
            onMouseLeave={() =>
              setHoveredId((cur) => (cur === post.id ? null : cur))
            }
            aria-pressed={isSelected}
            title={isUsed ? t.postPicker.alreadyUsedByTooltip(usedByName ?? "") : undefined}
            className={`
              relative aspect-square rounded overflow-hidden border-2 bg-surface
              ${
                isSelected
                  ? "border-accent"
                  : isUsed
                    ? "border-warning/40 hover:border-warning/60"
                    : "border-border hover:border-border-hover"
              }
            `}
          >
            {thumb ? (
              <img
                src={thumb}
                alt={post.caption?.slice(0, 50) ?? t.postPicker.instagramPostAlt}
                loading="lazy"
                decoding="async"
                onError={() =>
                  setFailedThumbIds((prev) => new Set(prev).add(post.id))
                }
                className={`w-full h-full object-cover ${isUsed ? "opacity-75" : ""}`}
              />
            ) : (
              <div className="w-full h-full bg-surface flex items-center justify-center">
                <span className="text-xs text-muted">{t.postPicker.noImage}</span>
              </div>
            )}
            {showVideo && (
              <video
                src={post.media_url}
                poster={thumb}
                autoPlay
                muted
                loop
                playsInline
                preload="none"
                className={`absolute inset-0 h-full w-full object-cover ${
                  isUsed ? "opacity-60" : ""
                }`}
              />
            )}
            {isSelected && (
              <span className="absolute bottom-0 inset-x-0 bg-accent text-background text-xs py-1">
                {t.postPicker.selected}
              </span>
            )}
          </button>
              );
            })}
          </div>
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              className="w-full rounded-lg border border-border py-2 text-sm text-muted hover:text-foreground"
            >
              {t.postPicker.showMore(Math.min(PAGE_SIZE, remaining))}
            </button>
          )}
        </>
      )}
    </div>
  );
}
