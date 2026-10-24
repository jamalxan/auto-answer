"use client";

/**
 * Faza 2 WP-D pieces of the calendar: the "Ko'chirish" move form (the
 * keyboard / phone fallback of drag-and-drop, FR-S6), the bulk bar of the
 * list view (FR-V4), the feed grid preview (FR-V3) and the best-times hook
 * and composer chips (FR-S7).
 */

import { useEffect, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { EMPTY_REVIEW, ReviewForm, reviewDraftIssue, type MetaWithReviewers, type ReviewDraft } from "./reviews";
import {
  BEST_TIMES_SOURCE_LABEL,
  bestTimeLabel,
  bulkSummary,
  CONTENT_API,
  formatZoned,
  fromLocalInput,
  jsonInit,
  nextOccurrence,
  requestJson,
  STATUS_LABEL,
  toLocalInput,
  TYPE_ICON,
  type AccountFeed,
  type BestTimes,
  type BulkAction,
  type BulkReport,
  type ContentMeta,
  type PostCard,
  type PostTypeValue,
} from "./shared";

// ─── Move (FR-S6) ───────────────────────────────────────────────────────────

/** POST posts/{id}/move — the server applies every scheduling rule. */
export function movePostRequest(id: string, at: Date) {
  return requestJson<{ id: string; status: PostCard["status"]; scheduledAt: string | null; version: number }>(`${CONTENT_API}/posts/${id}/move`, jsonInit("POST", { scheduledAt: at.toISOString() }));
}

export function MoveForm({ post, tz, onDone, onCancel }: { post: Pick<PostCard, "id" | "scheduledAt" | "status">; tz: string; onDone: (scheduledAt: string | null) => void; onCancel: () => void }) {
  const [value, setValue] = useState(() => toLocalInput(post.scheduledAt, tz));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const at = fromLocalInput(value, tz);
    if (!at) return setError("Sana va vaqtni tanlang");
    setBusy(true);
    setError(null);
    const res = await movePostRequest(post.id, at);
    setBusy(false);
    if (res.ok) onDone(res.data.scheduledAt);
    else setError(res.error);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-hover/40 p-2" onClick={(e) => e.stopPropagation()}>
      <label className="flex items-center gap-2 text-xs text-muted">
        Yangi vaqt ({tz})
        <input type="datetime-local" className={`${inputClass} !w-auto !py-1`} value={value} step={300} onChange={(e) => setValue(e.target.value)} autoFocus />
      </label>
      <button type="button" className={`${primaryButton} !px-3 !py-1 text-xs`} disabled={busy || !value} onClick={() => void submit()}>
        {busy ? "Ko'chirilmoqda…" : "Ko'chirish"}
      </button>
      <button type="button" className={`${secondaryButton} !py-1 text-xs`} onClick={onCancel}>
        Bekor
      </button>
      {post.status === "DRAFT" && <span className="text-[11px] text-muted">Draft draftligicha qoladi — faqat reja vaqti o&apos;zgaradi.</span>}
      {error && <span className="w-full text-xs text-error">{error}</span>}
    </div>
  );
}

// ─── Bulk (FR-V4) ───────────────────────────────────────────────────────────

const UNIT_LABEL = { minutes: "daqiqa", hours: "soat", days: "kun" } as const;

export function BulkBar({ meta, selected, onClear, onDone }: { meta: ContentMeta; selected: string[]; onClear: () => void; onDone: (report: BulkReport) => void }) {
  const [amount, setAmount] = useState(1);
  const [unit, setUnit] = useState<keyof typeof UNIT_LABEL>("hours");
  const [direction, setDirection] = useState<1 | -1>(1);
  const [review, setReview] = useState<ReviewDraft | null>(null);
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(action: BulkAction, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    const res = await requestJson<BulkReport>(`${CONTENT_API}/posts/bulk`, jsonInit("POST", { action, ids: selected, ...extra }));
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setReview(null);
    onDone(res.data);
  }

  const n = selected.length;
  const reviewIssue = review ? reviewDraftIssue(review) : null;
  return (
    <div className="space-y-2 rounded-2xl border border-accent/40 bg-surface p-3" aria-label="Ommaviy amallar">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{n} ta tanlandi</span>
        <button type="button" className={`${secondaryButton} !py-1 text-xs`} onClick={onClear}>
          Tanlovni bekor qilish
        </button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <select className={`${inputClass} !w-auto !py-1`} value={direction} onChange={(e) => setDirection(Number(e.target.value) as 1 | -1)} aria-label="Yo'nalish">
          <option value={1}>+ keyinga</option>
          <option value={-1}>− oldinga</option>
        </select>
        <input type="number" min={1} max={1000} className={`${inputClass} !w-20 !py-1`} value={amount} onChange={(e) => setAmount(Math.max(1, Math.floor(Number(e.target.value) || 1)))} aria-label="Miqdor" />
        <select className={`${inputClass} !w-auto !py-1`} value={unit} onChange={(e) => setUnit(e.target.value as keyof typeof UNIT_LABEL)} aria-label="Birlik">
          {Object.entries(UNIT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button type="button" className={`${secondaryButton} !py-1 text-xs`} disabled={busy !== null || n === 0 || !meta.me.canCreate} onClick={() => void send("shift", { amount: amount * direction, unit })}>
          {busy === "shift" ? "Surilmoqda…" : "Vaqtni surish"}
        </button>
        {meta.me.canSchedule && (
          <button type="button" className={`${secondaryButton} !py-1 text-xs`} disabled={busy !== null || n === 0} onClick={() => void send("pause")}>
            Pauza
          </button>
        )}
        {meta.me.canCreate && (
          <button type="button" className={`${secondaryButton} !py-1 text-xs ${review ? "border-accent/60 text-foreground" : ""}`} disabled={busy !== null || n === 0} onClick={() => setReview((r) => (r ? null : EMPTY_REVIEW))}>
            Tasdiqqa yuborish
          </button>
        )}
        {meta.me.canSchedule && (
          <button
            type="button"
            className={`${secondaryButton} !py-1 text-xs text-error`}
            disabled={busy !== null || n === 0}
            onClick={() => {
              if (window.confirm(`${n} ta postni o'chirasizmi? Instagram'dagi postlar (bo'lsa) o'chmaydi.`)) void send("delete");
            }}
          >
            O&apos;chirish
          </button>
        )}
      </div>
      {review && (
        <div className="space-y-2 border-t border-border pt-2">
          <p className="text-xs text-muted">Har bir draft o&apos;zining reja vaqti bilan yuboriladi; vaqti yo&apos;q postlar xato sifatida ko&apos;rsatiladi.</p>
          <ReviewForm meta={meta as MetaWithReviewers} value={review} onChange={setReview} />
          <button type="button" className={`${primaryButton} !py-1 text-xs`} disabled={busy !== null || Boolean(reviewIssue)} title={reviewIssue ?? undefined} onClick={() => void send("review", { ...review })}>
            {busy === "review" ? "Yuborilmoqda…" : `${n} ta postni tasdiqqa yuborish`}
          </button>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

/** What came back from a bulk call: the count, then every failure with its reason. */
export function BulkResult({ report, posts, tz, onClose }: { report: BulkReport; posts: PostCard[]; tz: string; onClose: () => void }) {
  const failures = report.results.filter((r) => !r.ok);
  const label = (id: string) => {
    const p = posts.find((x) => x.id === id);
    if (!p) return id;
    return `${p.scheduledAt ? formatZoned(new Date(p.scheduledAt), tz) : "vaqtsiz"} · ${(p.caption ?? "").slice(0, 40) || STATUS_LABEL[p.status]}`;
  };
  return (
    <Notice tone={failures.length ? "warning" : "info"}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{bulkSummary(report)}</p>
          {failures.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {failures.map((f) => (
                <li key={f.id}>
                  {label(f.id)}: {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" className="text-xs underline" onClick={onClose}>
          Yopish
        </button>
      </div>
    </Notice>
  );
}

// ─── Best times (FR-S7) ─────────────────────────────────────────────────────

const bestTimesCache = new Map<string, BestTimes>();

export function useBestTimes(accountId: string | undefined): { data: BestTimes | null; error: string | null } {
  const [state, setState] = useState<{ key: string; data: BestTimes | null; error: string | null }>({ key: "", data: null, error: null });
  useEffect(() => {
    if (!accountId) return;
    const cached = bestTimesCache.get(accountId);
    let alive = true;
    if (cached) {
      queueMicrotask(() => alive && setState({ key: accountId, data: cached, error: null }));
      return () => {
        alive = false;
      };
    }
    void requestJson<BestTimes>(`${CONTENT_API}/accounts/${accountId}/best-times`).then((res) => {
      if (!alive) return;
      if (res.ok) {
        bestTimesCache.set(accountId, res.data);
        setState({ key: accountId, data: res.data, error: null });
      } else setState({ key: accountId, data: null, error: res.error });
    });
    return () => {
      alive = false;
    };
  }, [accountId]);
  return state.key === accountId ? { data: state.data, error: state.error } : { data: null, error: null };
}

/** Composer: "Eng yaxshi vaqt: Ju 19:00" chips; a click puts the next such slot into the picker. */
export function BestTimeChips({ accountId, tz, onPick }: { accountId: string | undefined; tz: string; onPick: (slot: { date: string; time: string }) => void }) {
  const { data } = useBestTimes(accountId);
  if (!data) return null;
  if (data.source === "none") return <p className="text-xs text-muted">Eng yaxshi vaqt: ma&apos;lumot yetarli emas</p>;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted" title={BEST_TIMES_SOURCE_LABEL[data.source]}>
        Eng yaxshi vaqt:
      </span>
      {data.top.map((cell) => (
        <button key={`${cell.weekday}-${cell.hour}`} type="button" className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-semibold text-accent hover:bg-accent/20" onClick={() => onPick(nextOccurrence(cell.weekday, cell.hour, tz))}>
          {bestTimeLabel(cell)}
        </button>
      ))}
    </div>
  );
}

// ─── Feed grid (FR-V3) ──────────────────────────────────────────────────────

export function FeedGrid({ accountId, tz, refreshKey, onOpen }: { accountId: string | undefined; tz: string; refreshKey: number; onOpen: (id: string) => void }) {
  const [feed, setFeed] = useState<AccountFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    void requestJson<AccountFeed>(`${CONTENT_API}/accounts/${accountId}/feed`).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setFeed(res.data);
        setError(null);
      } else setError(res.error);
    });
    return () => {
      alive = false;
    };
  }, [accountId, refreshKey]);

  if (!accountId) return <p className="text-sm text-muted">Grid uchun akkaunt ulang.</p>;
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!feed) return <p className="text-sm text-muted">Yuklanmoqda…</p>;
  const plannedCount = feed.items.filter((i) => i.source === "planned").length;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        @{feed.username} profili shunday ko&apos;rinadi: rejalashtirilganlar ({plannedCount}) tepada, eng uzoq kelajakdagisi chap yuqorida; draftlar xira. Story va Trial Reels grid&apos;da chiqmaydi.
      </p>
      {feed.notice && <Notice tone="warning">{feed.notice}</Notice>}
      {feed.items.length === 0 ? (
        <p className="text-sm text-muted">Hali grid&apos;da ko&apos;rsatadigan post yo&apos;q.</p>
      ) : (
        <ul className="mx-auto grid max-w-md grid-cols-3 gap-0.5 overflow-hidden rounded-xl border border-border bg-border">
          {feed.items.map((tile) => (
            <li key={tile.key} className={`relative aspect-[4/5] bg-surface ${tile.draft ? "opacity-40" : ""}`}>
              <GridTile tile={tile} tz={tz} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function GridTile({ tile, tz, onOpen }: { tile: AccountFeed["items"][number]; tz: string; onOpen: (id: string) => void }) {
  const icon = tile.mediaType in TYPE_ICON ? TYPE_ICON[tile.mediaType as PostTypeValue] : tile.mediaType === "VIDEO" ? "▶" : tile.mediaType === "CAROUSEL_ALBUM" ? "▣▣" : "▣";
  const body = (
    <>
      {tile.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- Instagram CDN / signed URL, short-lived
        <img src={tile.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-lg text-muted">{icon}</span>
      )}
      {tile.source === "planned" && (
        <span className="absolute left-1 top-1 rounded bg-background/80 px-1 text-[10px] font-semibold text-foreground">
          {tile.draft ? "Draft · " : ""}
          {formatZoned(new Date(tile.at), tz)}
        </span>
      )}
    </>
  );
  if (tile.source === "planned" && tile.postId) {
    const id = tile.postId;
    return (
      <button type="button" className="block h-full w-full" onClick={() => onOpen(id)} title={tile.status ? STATUS_LABEL[tile.status] : undefined}>
        {body}
      </button>
    );
  }
  if (tile.permalink) {
    return (
      <a href={tile.permalink} target="_blank" rel="noreferrer" className="block h-full w-full" title="Instagram'da ochish">
        {body}
      </a>
    );
  }
  return <div className="h-full w-full">{body}</div>;
}
