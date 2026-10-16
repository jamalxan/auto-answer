"use client";

/**
 * One-post picker for a giveaway: recent posts with thumbnails, posts people
 * already commented on, and a manual id. Keeps the permalink / caption of the
 * chosen post (cached in Giveaway.mediaMeta). Stale responses for a
 * previously selected account are dropped.
 */

import { useEffect, useRef, useState } from "react";
import { formatDateTime, inputClass, secondaryButton } from "@/components/developer/ui";
import { ENGAGEMENT_API, requestJson } from "./shared";

export interface PickedPost {
  mediaId: string;
  meta: { permalink?: string; caption?: string; previewUrl?: string } | null;
}

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

export default function PostPicker({
  accountId,
  value,
  onChange,
  disabled,
}: {
  accountId: string;
  value: PickedPost | null;
  onChange: (post: PickedPost | null) => void;
  disabled?: boolean;
}) {
  const [data, setData] = useState<MediaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [manual, setManual] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (!accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the account is cleared
      setData(null);
      return;
    }
    setLoading(true);
    requestJson<MediaResponse>(`${ENGAGEMENT_API}/media?accountId=${encodeURIComponent(accountId)}`)
      .then((res) => {
        if (mine !== seq.current) return;
        setData(res.ok ? res.data : null);
        setError(res.ok ? null : res.error);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [accountId, reloadKey]);

  if (!accountId) return <p className="text-xs text-muted">Avval akkauntni tanlang — shundan keyin postlar chiqadi.</p>;

  const posts = data?.posts ?? [];
  const liveError = error ?? data?.error ?? null;

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      {value && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-accent/5 px-3 py-2 text-xs">
          <span className="min-w-0 break-words text-foreground">
            Tanlangan post: <b>{value.meta?.caption?.slice(0, 80) || shortId(value.mediaId)}</b>
          </span>
          {!disabled && (
            <button type="button" className="text-muted hover:text-foreground" onClick={() => onChange(null)}>
              Bekor qilish
            </button>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
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
            const on = value?.mediaId === post.id;
            const caption = post.caption?.trim() || post.mediaType || "Post";
            return (
              <button
                key={post.id}
                type="button"
                disabled={disabled}
                onClick={() =>
                  onChange({ mediaId: post.id, meta: { permalink: post.permalink ?? undefined, caption: post.caption ?? undefined, previewUrl: post.previewUrl ?? undefined } })
                }
                aria-pressed={on}
                aria-label={`${caption.slice(0, 60)} — ${on ? "tanlangan" : "tanlash"}`}
                title={caption}
                className={`relative aspect-square overflow-hidden rounded-lg border-2 bg-surface-hover disabled:opacity-60 ${on ? "border-accent" : "border-transparent"}`}
              >
                {post.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN, short-lived URLs
                  <img src={post.previewUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <span className="grid h-full place-items-center p-1 text-[10px] text-muted">{post.mediaType ?? "Post"}</span>
                )}
                <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-left text-[10px] text-white">
                  {post.commentsCount !== null ? `${post.commentsCount} izoh · ` : ""}
                  {post.timestamp ? formatDateTime(post.timestamp) : shortId(post.id)}
                </span>
                {on && <span className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-accent text-xs font-bold text-background">✓</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="space-y-2 text-xs text-muted">
          <p>
            {liveError
              ? `Instagram'dan postlarni olib bo'lmadi: ${liveError}. Pastdan izoh kelgan postni tanlang yoki post ID ni qo'lda kiriting.`
              : "Bu akkauntda post topilmadi."}
          </p>
          {liveError && (
            <button type="button" className={secondaryButton} onClick={() => setReloadKey((k) => k + 1)}>
              Qayta urinish
            </button>
          )}
        </div>
      )}

      {data && data.commented.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold text-muted">Izoh kelgan postlar</p>
          <div className="flex flex-wrap gap-1.5">
            {data.commented.map((item) => {
              const on = value?.mediaId === item.mediaId;
              return (
                <button
                  key={item.mediaId}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ mediaId: item.mediaId, meta: null })}
                  aria-pressed={on}
                  className={`rounded-md border px-2 py-1 text-xs ${on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"}`}
                  title={`Oxirgi izoh: ${formatDateTime(item.lastCommentAt)}`}
                >
                  Post {shortId(item.mediaId)} · {item.comments} izoh
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!disabled && (
        <div className="flex gap-2">
          <input
            className={inputClass}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="Post ID ni qo'lda kiriting"
            aria-label="Post ID"
          />
          <button
            type="button"
            className={secondaryButton}
            disabled={!manual.trim()}
            onClick={() => {
              onChange({ mediaId: manual.trim(), meta: null });
              setManual("");
            }}
          >
            Tanlash
          </button>
        </div>
      )}
    </div>
  );
}
