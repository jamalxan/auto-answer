"use client";

/**
 * "Reja" — the planner's main screen. Every Post, Karusel, Reels and Story
 * of the window in ONE column, by day and time: a density strip of the next
 * two weeks on top (click a day to jump), then each day with its times on a
 * rail, the gaps between posts, a "Hozir" line today, and the stories of one
 * series folded into a single card. Drafts without a time sit in a tray
 * above. Data: one /posts call for the window (≤ 500 rows, first frame and
 * counts only) and one for the undated drafts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { inputClass, limeButton, secondaryButton } from "./ui";
import {
  CONTENT_API,
  DOT_CLASS,
  postCardTone,
  requestJson,
  STATUS_LABEL,
  todayIso,
  TONE_CLASS,
  utcToZoned,
  WEEKDAYS,
  zonedToUtc,
  type ContentMeta,
  type PostCard,
  type PostStatusValue,
} from "./shared";
import {
  addDays,
  buildTimeline,
  countsLabel,
  dateLabel,
  dateRange,
  dayName,
  densityByDay,
  emptyRun,
  entryEnd,
  gapLabel,
  GROUP_LABEL,
  GROUP_ORDER,
  nowIndex,
  relativeTime,
  TYPE_GROUP,
  weekdayIndex,
  type TimelineDay,
  type TimelineEntry,
  type TypeGroup,
} from "./timeline";
import { GROUP_BADGE, TypeBadge, TypeGlyph } from "./type-glyph";

const WINDOW_STEP = 14;
const PAGE = 500;

type StatusFilter = "" | "planned" | "draft" | "problem" | "done";

const STATUS_FILTERS: Array<[StatusFilter, string]> = [
  ["", "Hammasi"],
  ["planned", "Rejada"],
  ["draft", "Draft"],
  ["problem", "E'tibor kerak"],
  ["done", "Chiqdi"],
];

const STATUS_GROUP: Record<PostStatusValue, StatusFilter | null> = {
  SCHEDULED: "planned",
  PENDING_REVIEW: "planned",
  PAUSED: "planned",
  PREPARING: "planned",
  READY_TO_PUBLISH: "planned",
  PUBLISHING: "planned",
  DRAFT: "draft",
  FAILED: "problem",
  NEEDS_MANUAL: "problem",
  REJECTED: "problem",
  EXPIRED_REVIEW: "problem",
  PUBLISHED: "done",
  PUBLISHED_MANUAL: "done",
  // Cancelled posts stay in Kalendar → Ro'yxat; the plan shows what will (or did) go out.
  CANCELED: null,
};

const BAR_CLASS: Record<TypeGroup, string> = {
  reels: "bg-violet",
  story: "bg-lime",
  post: "bg-cloud/70",
  carousel: "bg-cloud/40",
};

export default function TimelineView({
  meta,
  refreshKey,
  onOpen,
  onCreate,
}: {
  meta: ContentMeta;
  refreshKey: number;
  onOpen: (id: string) => void;
  onCreate: (date: string) => void;
}) {
  const tz = meta.timezone;
  const [now, setNow] = useState(() => Date.now());
  const today = todayIso(tz);
  const [account, setAccount] = useState("");
  const [group, setGroup] = useState<TypeGroup | "">("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [showPast, setShowPast] = useState(false);
  const [days, setDays] = useState(WINDOW_STEP);
  const [posts, setPosts] = useState<PostCard[] | null>(null);
  const [drafts, setDrafts] = useState<PostCard[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const from = showPast ? addDays(today, -WINDOW_STEP) : today;
  const to = addDays(today, days - 1);

  // The "Hozir" line and the "… dan keyin" labels move on their own.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const mine = ++seq.current;
    const range = new URLSearchParams({ pageSize: String(PAGE), from: zonedToUtc(from, "00:00", tz).toISOString(), to: zonedToUtc(addDays(to, 1), "00:00", tz).toISOString() });
    const undated = new URLSearchParams({ pageSize: "60", unscheduled: "1", status: "DRAFT" });
    if (account) {
      range.set("account", account);
      undated.set("account", account);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on window / filter change
    setLoading(true);
    void Promise.all([
      requestJson<{ items: PostCard[]; total: number }>(`${CONTENT_API}/posts?${range.toString()}`),
      requestJson<{ items: PostCard[]; total: number }>(`${CONTENT_API}/posts?${undated.toString()}`),
    ]).then(([res, tray]) => {
      if (mine !== seq.current) return;
      setLoading(false);
      if (res.ok) {
        setPosts(res.data.items);
        setTruncated(res.data.total > res.data.items.length);
        setFailure(null);
      } else setFailure(res.error);
      if (tray.ok) setDrafts(tray.data.items);
    });
  }, [account, from, to, tz, refreshKey]);

  const visible = useMemo(
    () => (posts ?? []).filter((p) => STATUS_GROUP[p.status] !== null && (!group || TYPE_GROUP[p.type] === group) && (!status || STATUS_GROUP[p.status] === status)),
    [posts, group, status]
  );
  const timeline = useMemo(() => buildTimeline(visible, tz), [visible, tz]);
  const strip = useMemo(() => densityByDay(timeline, dateRange(today, addDays(today, WINDOW_STEP - 1))), [timeline, today]);
  const groupCounts = useMemo(() => {
    const counts: Record<TypeGroup, number> = { post: 0, carousel: 0, reels: 0, story: 0 };
    for (const p of posts ?? []) if (STATUS_GROUP[p.status] !== null && (!status || STATUS_GROUP[p.status] === status)) counts[TYPE_GROUP[p.type]]++;
    return counts;
  }, [posts, status]);

  // Today is always on the plan (with its empty state) when it is in the window.
  const sections = useMemo(() => {
    const list = [...timeline];
    if (today >= from && today <= to && !list.some((d) => d.date === today)) {
      list.push({ date: today, entries: [], counts: { post: 0, carousel: 0, reels: 0, story: 0 } });
      list.sort((a, b) => a.date.localeCompare(b.date));
    }
    return list;
  }, [timeline, today, from, to]);

  // With the past shown, open on today rather than two weeks ago.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!showPast || !posts || scrolledFor.current === from) return;
    scrolledFor.current = from;
    document.getElementById(`day-${today}`)?.scrollIntoView({ block: "start" });
  }, [showPast, posts, from, today]);

  const jump = (date: string) => {
    const el = document.getElementById(`day-${date}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (meta.me.canCreate && date >= today) onCreate(date);
  };

  const multiAccount = meta.accounts.length > 1;
  const maxDay = Math.max(1, ...strip.map((d) => d.total));

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="panel space-y-3 rounded-3xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Tur">
          <button type="button" className={`chip ${group === "" ? "chip-active" : "bg-midnight"}`} onClick={() => setGroup("")}>
            Hammasi
          </button>
          {GROUP_ORDER.map((g) => (
            <button key={g} type="button" aria-pressed={group === g} className={`chip ${group === g ? "chip-active" : "bg-midnight"}`} onClick={() => setGroup(group === g ? "" : g)}>
              <TypeGlyph group={g} width={15} height={15} />
              {GROUP_LABEL[g]}
              <span className="tabular-nums opacity-70">{groupCounts[g]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Holat">
            {STATUS_FILTERS.map(([key, label]) => (
              <button key={key || "all"} type="button" aria-pressed={status === key} className={`chip !px-3 !py-1.5 text-[13px] ${status === key ? "chip-active" : "bg-midnight"}`} onClick={() => setStatus(key)}>
                {label}
              </button>
            ))}
          </div>
          {meta.accounts.length > 1 && (
            <select className={`${inputClass} !w-auto !py-1.5 text-sm`} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Akkaunt">
              <option value="">Barcha akkauntlar</option>
              {meta.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                </option>
              ))}
            </select>
          )}
          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input type="checkbox" className="h-4 w-4" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
            O&apos;tgan 2 haftani ham ko&apos;rsatish
          </label>
        </div>
      </div>

      {/* Two weeks at a glance */}
      <div className="panel overflow-x-auto rounded-3xl p-3 sm:p-4" aria-label="Keyingi 14 kun">
        <ol className="grid min-w-[640px] grid-cols-14 gap-1.5">
          {strip.map((d) => {
            const isToday = d.date === today;
            return (
              <li key={d.date}>
                <button
                  type="button"
                  onClick={() => jump(d.date)}
                  title={d.total ? countsLabel(d.counts) : "Bo'sh kun — bosib post yarating"}
                  className={`flex h-full w-full flex-col items-center gap-1.5 rounded-2xl px-1 py-2 transition-colors hover:bg-surface-hover ${isToday ? "bg-midnight" : ""}`}
                >
                  <span className={`text-[11px] font-semibold ${isToday ? "text-lime" : "text-muted"}`}>{WEEKDAYS[weekdayIndex(d.date)]}</span>
                  <span className={`display text-base ${isToday ? "text-lime" : "text-white"}`}>{Number(d.date.slice(8, 10))}</span>
                  <span className="flex h-12 w-3 flex-col-reverse overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
                    {GROUP_ORDER.map((g) =>
                      d.counts[g] ? <span key={g} className={BAR_CLASS[g]} style={{ height: `${(d.counts[g] / maxDay) * 100}%` }} /> : null
                    )}
                  </span>
                  <span className={`text-xs tabular-nums ${d.total ? "font-semibold text-white" : "text-muted/60"}`}>{d.total || "·"}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted">
          {GROUP_ORDER.map((g) => (
            <span key={g} className="inline-flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${BAR_CLASS[g]}`} aria-hidden="true" />
              {GROUP_LABEL[g]}
            </span>
          ))}
        </p>
      </div>

      {failure && <Notice tone="error">{failure}</Notice>}
      {truncated && <Notice tone="warning">Bu oraliqda {PAGE} tadan ko&apos;p post bor — filtr yoki akkaunt tanlang, aks holda oxirgilari ko&apos;rinmaydi.</Notice>}

      {drafts.length > 0 && <DraftTray drafts={drafts} onOpen={onOpen} />}

      {loading && !posts && <TimelineSkeleton />}

      {posts && (
        <div className="space-y-2">
          {sections.map((day, i) => {
            const prev = sections[i - 1];
            const gapDays = prev ? emptyRun(prev.date, day.date) : 0;
            return (
              <div key={day.date}>
                {gapDays > 0 && (
                  <EmptyDays count={gapDays} firstDate={addDays(prev!.date, 1)} canCreate={meta.me.canCreate && addDays(prev!.date, 1) >= today} onCreate={onCreate} />
                )}
                <DaySection day={day} today={today} now={now} tz={tz} multiAccount={multiAccount} canCreate={meta.me.canCreate} onOpen={onOpen} onCreate={onCreate} />
              </div>
            );
          })}
          {sections.length === 0 && !loading && (
            <div className="panel rounded-3xl px-6 py-14 text-center">
              <p className="display text-xl text-white">Reja hali bo&apos;sh</p>
              <p className="mx-auto mt-2 max-w-md text-[15px] leading-6 text-muted">Post, Reels yoki Story yarating — ular shu yerda kun va soat bo&apos;yicha tartib bilan turadi.</p>
              {meta.me.canCreate && (
                <button type="button" className={`${limeButton} mt-5`} onClick={() => onCreate(today)}>
                  Birinchi postni rejalashtirish
                </button>
              )}
            </div>
          )}
          <div className="flex justify-center pt-2">
            <button type="button" className={secondaryButton} onClick={() => setDays((d) => d + WINDOW_STEP)} disabled={loading}>
              {loading ? "Yuklanmoqda…" : `Keyingi ${WINDOW_STEP} kunni ko'rsatish`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DaySection({
  day,
  today,
  now,
  tz,
  multiAccount,
  canCreate,
  onOpen,
  onCreate,
}: {
  day: TimelineDay;
  today: string;
  now: number;
  tz: string;
  multiAccount: boolean;
  canCreate: boolean;
  onOpen: (id: string) => void;
  onCreate: (date: string) => void;
}) {
  const isToday = day.date === today;
  const past = day.date < today;
  const cutAt = isToday ? nowIndex(day.entries, now) : -1;
  const label = countsLabel(day.counts);

  return (
    <section id={`day-${day.date}`} aria-label={`${dayName(day.date, today)}, ${dateLabel(day.date, today)}`} className="scroll-mt-24">
      <header className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-2 bg-background/90 px-1 py-3 backdrop-blur">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h3 className={`display text-lg sm:text-xl ${isToday ? "text-lime" : past ? "text-muted" : "text-white"}`}>{dayName(day.date, today)}</h3>
          <span className="text-sm text-muted">{dateLabel(day.date, today)}</span>
        </div>
        <div className="flex items-center gap-3">
          {label && <span className="hidden text-sm text-muted sm:inline">{label}</span>}
          {canCreate && !past && (
            <button type="button" className={`${secondaryButton} !px-3 !py-1.5`} onClick={() => onCreate(day.date)} aria-label={`${dateLabel(day.date, today)} ga qo'shish`}>
              + Qo&apos;shish
            </button>
          )}
        </div>
      </header>

      {day.entries.length === 0 ? (
        <div className="inset ml-16 flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:ml-24">
          <span className="text-[15px] text-muted">Bugun hali hech narsa rejalashtirilmagan.</span>
          {canCreate && (
            <button type="button" className={limeButton} onClick={() => onCreate(day.date)}>
              Rejalashtirish
            </button>
          )}
        </div>
      ) : (
        <ol className="relative">
          {/* the rail */}
          <span className="absolute bottom-3 left-[65px] top-3 w-0.5 rounded-full bg-white/[0.07] sm:left-[85px]" aria-hidden="true" />
          {day.entries.map((entry, i) => {
            const prev = day.entries[i - 1];
            const gap = prev ? gapLabel(entryEnd(prev), entry.at) : null;
            return (
              <li key={entry.key}>
                {isToday && i === cutAt && <NowLine now={now} tz={tz} />}
                {gap && !(isToday && i === cutAt) && (
                  <p className="py-1 pl-[4.5rem] text-xs text-muted/70 sm:pl-[6rem]">{gap}</p>
                )}
                <EntryRow entry={entry} now={now} tz={tz} multiAccount={multiAccount} onOpen={onOpen} />
              </li>
            );
          })}
          {isToday && cutAt === day.entries.length && (
            <li>
              <NowLine now={now} tz={tz} />
            </li>
          )}
        </ol>
      )}
    </section>
  );
}

function NowLine({ now, tz }: { now: number; tz: string }) {
  const time = utcToZoned(new Date(now), tz).time;
  return (
    <div className="relative flex items-center gap-3 py-2" aria-label={`Hozir ${time}`}>
      <span className="w-12 shrink-0 whitespace-nowrap text-right text-xs font-bold tabular-nums text-lime sm:w-[4.25rem]">{time}</span>
      <span className="relative z-[1] h-3 w-3 shrink-0 rounded-full bg-lime ring-4 ring-lime/20" aria-hidden="true" />
      <span className="h-0.5 flex-1 rounded-full bg-lime/40" aria-hidden="true" />
      <span className="text-xs font-semibold text-lime">Hozir</span>
    </div>
  );
}

function EntryRow({ entry, now, tz, multiAccount, onOpen }: { entry: TimelineEntry; now: number; tz: string; multiAccount: boolean; onOpen: (id: string) => void }) {
  const tone = postCardTone(entry.kind === "post" ? entry.post.status : entry.posts[0].status);
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="w-12 shrink-0 whitespace-nowrap pt-4 text-right sm:w-[4.25rem]">
        <span className="display block text-sm tabular-nums text-white sm:text-lg">{entry.time}</span>
        {entry.kind === "series" && <span className="block text-[11px] tabular-nums text-muted">–{entry.endTime}</span>}
      </span>
      <span className={`relative z-[1] mt-5 h-3 w-3 shrink-0 rounded-full ring-4 ring-background ${DOT_CLASS[tone]}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {entry.kind === "post" ? (
          <PostRowCard post={entry.post} now={now} multiAccount={multiAccount} onOpen={onOpen} />
        ) : (
          <SeriesCard posts={entry.posts} now={now} tz={tz} multiAccount={multiAccount} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

function Thumb({ post, size = "md" }: { post: PostCard; size?: "md" | "sm" }) {
  const group = TYPE_GROUP[post.type];
  const tall = group === "reels" || group === "story";
  const dims = size === "sm" ? (tall ? "h-[72px] w-[41px]" : "h-[52px] w-[42px]") : tall ? "h-[112px] w-[63px] sm:h-[124px] sm:w-[70px]" : "h-[92px] w-[74px] sm:h-[104px] sm:w-[83px]";
  return (
    <span className={`relative block shrink-0 ${dims}`}>
      {group === "carousel" && size === "md" && <span className="absolute -right-1.5 top-1.5 bottom-1.5 w-full rounded-xl bg-white/[0.08]" aria-hidden="true" />}
      <span className={`relative block h-full w-full overflow-hidden rounded-xl bg-midnight ${group === "story" ? "ring-2 ring-lime/70 ring-offset-2 ring-offset-surface" : ""}`}>
        {post.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
          <img src={post.thumbUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted">
            <TypeGlyph group={group} width={20} height={20} />
          </span>
        )}
        {group === "reels" && post.thumbUrl && (
          <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-midnight/70 text-white" aria-hidden="true">
            <TypeGlyph group="reels" width={12} height={12} />
          </span>
        )}
        {group === "carousel" && post.mediaCount > 1 && (
          <span className="absolute right-1 top-1 rounded-full bg-midnight/80 px-1.5 text-[10px] font-bold tabular-nums text-white">{post.mediaCount}</span>
        )}
      </span>
    </span>
  );
}

function PostRowCard({ post, now, multiAccount, onOpen }: { post: PostCard; now: number; multiAccount: boolean; onOpen: (id: string) => void }) {
  const tone = postCardTone(post.status);
  const at = post.scheduledAt ? new Date(post.scheduledAt).getTime() : null;
  const done = post.status === "PUBLISHED" || post.status === "PUBLISHED_MANUAL";
  const caption = post.caption?.trim();
  return (
    <div className={`group relative flex gap-3.5 rounded-3xl bg-surface p-3 transition-colors hover:bg-surface-hover sm:gap-4 sm:p-3.5 ${post.status === "DRAFT" ? "opacity-80" : ""}`}>
      <button type="button" onClick={() => onOpen(post.id)} className="absolute inset-0 rounded-3xl" aria-label={`Ochish: ${post.type} ${STATUS_LABEL[post.status]}`} />
      <Thumb post={post} />
      <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-2 py-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <TypeBadge type={post.type} />
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[tone]}`}>{STATUS_LABEL[post.status]}</span>
          {multiAccount && post.accountUsername && <span className="text-xs text-muted">@{post.accountUsername}</span>}
          {at && !done && <span className="ml-auto hidden text-xs text-muted sm:inline">{relativeTime(at, now)}</span>}
        </div>
        <p className={`line-clamp-2 text-[15px] leading-6 ${caption ? "text-cloud" : "text-muted/70"}`}>
          {caption || (post.type === "STORY" ? "Story — caption yo'q" : "Caption yozilmagan")}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {post.linked && <span className="rounded-full bg-lime/12 px-2 py-0.5 font-semibold text-lime">DM kampaniya</span>}
          {!post.autoPublish && <span className="rounded-full bg-warning/12 px-2 py-0.5 font-semibold text-warning">Qo&apos;lda e&apos;lon</span>}
          {post.lastErrorCode && post.status === "FAILED" && <span className="rounded-full bg-error/12 px-2 py-0.5 font-semibold text-error">{post.lastErrorCode}</span>}
          {post.seriesId && post.type !== "STORY" && <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-muted">Takroriy · {(post.seriesIndex ?? 0) + 1}</span>}
          {done && post.permalink && (
            <a href={post.permalink} target="_blank" rel="noreferrer" className="pointer-events-auto relative rounded-full bg-white/[0.06] px-2 py-0.5 text-cloud hover:bg-white/[0.12]">
              Instagram&apos;da ochish ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function SeriesCard({ posts, now, tz, multiAccount, onOpen }: { posts: PostCard[]; now: number; tz: string; multiAccount: boolean; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const first = posts[0];
  const at = first.scheduledAt ? new Date(first.scheduledAt).getTime() : null;
  const shown = posts.slice(0, 8);
  const statuses = [...new Set(posts.map((p) => p.status))];
  return (
    <div className="rounded-3xl bg-surface p-3 sm:p-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${GROUP_BADGE.story}`}>
          <TypeGlyph group="story" width={14} height={14} />
          Story seriyasi · {posts.length} ta
        </span>
        {statuses.map((s) => (
          <span key={s} className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[postCardTone(s)]}`}>
            {STATUS_LABEL[s]}
          </span>
        ))}
        {multiAccount && first.accountUsername && <span className="text-xs text-muted">@{first.accountUsername}</span>}
        {at && <span className="ml-auto hidden text-xs text-muted sm:inline">{relativeTime(at, now)}</span>}
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {shown.map((p) => (
          <button key={p.id} type="button" onClick={() => onOpen(p.id)} className="shrink-0 rounded-xl" title={`${(p.seriesIndex ?? 0) + 1}-story · ${STATUS_LABEL[p.status]}`}>
            <Thumb post={p} size="sm" />
          </button>
        ))}
        {posts.length > shown.length && <span className="grid w-10 shrink-0 place-items-center text-sm font-semibold text-muted">+{posts.length - shown.length}</span>}
      </div>
      <button type="button" className="mt-2 text-xs font-semibold text-muted hover:text-white" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Yig'ish" : "Har birini ko'rish"}
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {posts.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onOpen(p.id)} className="inset flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-hover">
                <span className="w-6 text-xs tabular-nums text-muted">{(p.seriesIndex ?? 0) + 1}</span>
                <span className="tabular-nums text-white">{p.scheduledAt ? utcToZoned(new Date(p.scheduledAt), tz).time : "—"}</span>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[postCardTone(p.status)]}`}>{STATUS_LABEL[p.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyDays({ count, firstDate, canCreate, onCreate }: { count: number; firstDate: string; canCreate: boolean; onCreate: (date: string) => void }) {
  return (
    <div className="flex items-center gap-3 py-2 pl-[4.5rem] sm:pl-[6rem]">
      <span className="text-sm text-muted/70">{count} kun hech narsa rejalashtirilmagan</span>
      {canCreate && (
        <button type="button" className="text-sm font-semibold text-violet hover:text-white" onClick={() => onCreate(firstDate)}>
          Rejalashtirish →
        </button>
      )}
    </div>
  );
}

function DraftTray({ drafts, onOpen }: { drafts: PostCard[]; onOpen: (id: string) => void }) {
  return (
    <section className="panel rounded-3xl p-4 sm:p-5" aria-label="Vaqti belgilanmagan draftlar">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-base font-bold text-white">Vaqti belgilanmagan draftlar</h3>
        <span className="text-sm text-muted">{drafts.length} ta · ochib vaqt qo&apos;ying</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {drafts.map((p) => (
          <button key={p.id} type="button" onClick={() => onOpen(p.id)} className="inset flex w-60 shrink-0 items-center gap-3 p-2.5 text-left hover:bg-surface-hover">
            <Thumb post={p} size="sm" />
            <span className="min-w-0 flex-1">
              <TypeBadge type={p.type} />
              <span className="mt-1.5 line-clamp-2 block text-sm text-muted">{p.caption?.trim() || "Caption yozilmagan"}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3 pl-[4.5rem] sm:pl-[6rem]">
          <div className="panel h-[120px] flex-1 animate-pulse rounded-3xl" />
        </div>
      ))}
    </div>
  );
}
