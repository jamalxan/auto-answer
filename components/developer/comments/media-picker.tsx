"use client";

/**
 * "Faqat tanlangan postlar" picker: recent posts with thumbnails, posts that
 * already got comments (fallback when Instagram does not answer), and manual
 * ids. Stale responses for a previously selected account are dropped.
 */

import { useEffect, useRef, useState } from "react";
import { ChipInput, formatDateTime, secondaryButton } from "@/components/developer/ui";
import { requestJson } from "./shared";

interface MediaItem {
  id: string;
  caption: string | null;
  mediaType: string | null;
  previewUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
  commentsCount: number | null;
}

interface MediaResponse {
  posts: MediaItem[];
  error: string | null;
  commented: Array<{ mediaId: string; comments: number; lastCommentAt: string }>;
}

const shortId = (id: string) => `#${id.slice(-6)}`;

export default function MediaPicker({
  accountId,
  selected,
  onChange,
}: {
  accountId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [data, setData] = useState<MediaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (!accountId) return;
    const mine = ++seq.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for the fetch below
    setLoading(true);
    requestJson<MediaResponse>(`/api/comments/media?accountId=${encodeURIComponent(accountId)}`)
      .then((res) => {
        if (mine !== seq.current) return;
        setData(res.ok ? res.data : null);
        setError(res.ok ? null : res.error);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [accountId, reloadKey]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  const posts = data?.posts ?? [];
  const liveError = error ?? data?.error ?? null;

  return (
    <div className="space-y-4 rounded-lg border border-border p-3">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold text-muted">Oxirgi postlar</p>
          <button type="button" className="text-xs text-muted hover:text-foreground" onClick={() => setReloadKey((k) => k + 1)}>
            Yangilash
          </button>
        </div>
        {loading ? (
          <p className="text-xs text-muted">Yuklanmoqda…</p>
        ) : posts.length > 0 ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
            {posts.map((post) => {
              const on = selected.includes(post.id);
              const caption = post.caption?.trim() || post.mediaType || "Post";
              return (
                <button
                  key={post.id}
                  type="button"
                  onClick={() => toggle(post.id)}
                  aria-pressed={on}
                  aria-label={`${caption.slice(0, 60)} — ${on ? "tanlangan" : "tanlash"}`}
                  title={caption}
                  className={`relative aspect-square overflow-hidden rounded-lg border-2 bg-surface-hover ${
                    on ? "border-accent" : "border-transparent"
                  }`}
                >
                  {post.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN, short-lived URLs
                    <img src={post.previewUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <span className="grid h-full place-items-center p-1 text-[10px] text-muted">{post.mediaType ?? "Post"}</span>
                  )}
                  <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-left text-[10px] text-white">
                    {post.commentsCount !== null ? `💬 ${post.commentsCount} · ` : ""}
                    {post.timestamp ? formatDateTime(post.timestamp) : shortId(post.id)}
                  </span>
                  {on && (
                    <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-accent text-xs font-bold text-background">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-2 text-xs text-muted">
            <p>
              {liveError
                ? `Instagram'dan postlarni olib bo'lmadi: ${liveError}. Pastdagi ro'yxatdan tanlang yoki post ID ni qo'lda kiriting.`
                : "Bu akkauntda post topilmadi."}
            </p>
            {liveError && (
              <button type="button" className={secondaryButton} onClick={() => setReloadKey((k) => k + 1)}>
                Qayta urinish
              </button>
            )}
          </div>
        )}
      </div>

      {data && data.commented.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold text-muted">Komment kelgan postlar</p>
          <div className="flex flex-wrap gap-1.5">
            {data.commented.map((item) => {
              const on = selected.includes(item.mediaId);
              return (
                <button
                  key={item.mediaId}
                  type="button"
                  onClick={() => toggle(item.mediaId)}
                  aria-pressed={on}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
                  }`}
                  title={`Oxirgi komment: ${formatDateTime(item.lastCommentAt)}`}
                >
                  Post {shortId(item.mediaId)} · {item.comments} komment
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <p className="mb-2 text-xs font-semibold text-muted">
          Tanlangan post ID lar ({selected.length}) — qo&apos;lda ham qo&apos;shish mumkin
        </p>
        <ChipInput values={selected} onChange={onChange} placeholder="Post ID kiriting va Enter" max={100} />
      </div>
    </div>
  );
}
