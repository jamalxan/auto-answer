"use client";

/**
 * Month / week / list / grid of scheduled posts (spec §10.1). Cards: thumbnail, type
 * mark, time, status colour, "DM" when a campaign is linked. An empty day
 * cell opens the composer on that date. The quota pill reads the account's
 * real 24-hour quota.
 *
 * Faza 2 (WP-D): SCHEDULED and DRAFT cards drag to another day (month: the
 * time of day stays) or day + hour (week); the move is shown at once and
 * rolled back when the server refuses it (lead time, spacing, quota). The
 * list has checkboxes and a bulk bar, and a "Ko'chirish" date-time form per
 * row (the keyboard / phone fallback of dragging). The week view paints the
 * best-times heat map behind the hours; "Grid" previews the profile.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { inputClass, Pill, secondaryButton } from "@/components/developer/ui";
import { BulkBar, BulkResult, FeedGrid, MoveForm, movePostRequest, useBestTimes } from "./calendar-tools";
import {
  BEST_TIMES_SOURCE_LABEL,
  bestTimeLabel,
  canMovePost,
  CONTENT_API,
  DOT_CLASS,
  dropInstant,
  formatZoned,
  groupPostsByDay,
  heatClass,
  MONTHS,
  monthGrid,
  postCardTone,
  requestJson,
  STATUS_LABEL,
  todayIso,
  TONE_CLASS,
  TYPE_ICON,
  TYPE_LABEL,
  utcToZoned,
  WEEKDAYS,
  weekOf,
  zonedToUtc,
  type BulkReport,
  type ContentMeta,
  type PostCard,
  type PostStatusValue,
  type PostTypeValue,
} from "./shared";
import SlotsEditor from "./slots-editor";

type View = "month" | "week" | "list" | "grid";

const VIEW_LABEL: Record<View, string> = { month: "Oy", week: "Hafta", list: "Ro'yxat", grid: "Grid" };
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DRAG_TYPE = "application/x-socialauto-post";

interface Quota {
  used: number;
  total: number;
  scheduledNext24h: number;
  source: string;
}

export default function CalendarView({
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
  const today = todayIso(tz);
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(today);
  const [account, setAccount] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [type, setType] = useState<string>("");
  const [q, setQ] = useState("");
  const [linked, setLinked] = useState<string>("");
  const [posts, setPosts] = useState<PostCard[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [slotsOpen, setSlotsOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [moveNote, setMoveNote] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkReport, setBulkReport] = useState<BulkReport | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  const [year, month0] = [Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 1];
  const days = useMemo(() => (view === "week" ? weekOf(anchor) : monthGrid(year, month0)), [view, anchor, year, month0]);

  const load = useCallback(async () => {
    if (view === "grid") return;
    const mine = ++seq.current;
    const params = new URLSearchParams({ pageSize: "200" });
    if (view !== "list") {
      params.set("from", zonedToUtc(days[0], "00:00", tz).toISOString());
      params.set("to", new Date(zonedToUtc(days[days.length - 1], "23:59", tz).getTime() + 60_000).toISOString());
    }
    if (account) params.set("account", account);
    if (status) params.set("status", status);
    if (type) params.set("type", type);
    if (q.trim()) params.set("q", q.trim());
    if (linked) params.set("linked", linked);
    const res = await requestJson<{ items: PostCard[]; total: number }>(`${CONTENT_API}/posts?${params.toString()}`);
    if (mine !== seq.current) return;
    if (res.ok) {
      setPosts(res.data.items);
      setFailure(null);
    } else setFailure(res.error);
  }, [view, days, account, status, type, q, linked, tz]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter change
    void load();
  }, [load, refreshKey, reloadKey]);

  const quotaAccount = account || meta.accounts[0]?.id;
  useEffect(() => {
    if (!quotaAccount) return;
    let alive = true;
    void requestJson<Quota>(`${CONTENT_API}/accounts/${quotaAccount}/quota`).then((res) => {
      if (alive && res.ok) setQuota(res.data);
    });
    return () => {
      alive = false;
    };
  }, [quotaAccount, refreshKey, reloadKey]);

  const best = useBestTimes(view === "week" ? quotaAccount : undefined);
  const byDay = useMemo(() => groupPostsByDay(posts, tz), [posts, tz]);
  const me = meta.me;

  function shift(delta: number) {
    if (view === "week") {
      const d = new Date(`${anchor}T00:00:00Z`);
      setAnchor(new Date(d.getTime() + delta * 7 * 86_400_000).toISOString().slice(0, 10));
    } else {
      const d = new Date(Date.UTC(year, month0 + delta, 1));
      setAnchor(d.toISOString().slice(0, 10));
    }
  }

  /** FR-S6: optimistic move, rolled back when the server says no. */
  async function moveTo(post: PostCard, at: Date) {
    const before = { scheduledAt: post.scheduledAt, status: post.status, version: post.version };
    if (post.scheduledAt && new Date(post.scheduledAt).getTime() === at.getTime()) return;
    setMoveNote(null);
    setPosts((list) => list.map((p) => (p.id === post.id ? { ...p, scheduledAt: at.toISOString() } : p)));
    const res = await movePostRequest(post.id, at);
    if (!res.ok) {
      setPosts((list) => list.map((p) => (p.id === post.id ? { ...p, ...before } : p)));
      setMoveNote({ tone: "error", text: `Ko'chirilmadi: ${res.error}` });
      return;
    }
    setPosts((list) => list.map((p) => (p.id === post.id ? { ...p, scheduledAt: res.data.scheduledAt, status: res.data.status, version: res.data.version } : p)));
    const landed = res.data.scheduledAt ? new Date(res.data.scheduledAt) : at;
    setMoveNote({
      tone: "info",
      text: landed.getTime() !== at.getTime() ? `Bu daqiqada boshqa post bor — ${formatZoned(landed, tz)} ga qo'yildi` : `Ko'chirildi: ${formatZoned(landed, tz)}`,
    });
  }

  function dragProps(post: PostCard) {
    if (!canMovePost(post.status, me)) return {};
    return {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.setData(DRAG_TYPE, post.id);
        e.dataTransfer.setData("text/plain", post.id);
        e.dataTransfer.effectAllowed = "move";
        setDragId(post.id);
      },
      onDragEnd: () => {
        setDragId(null);
        setOverKey(null);
      },
    };
  }

  function dropProps(key: string, day: string, hour: number | null) {
    if (!dragId || day < today) return {};
    return {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (overKey !== key) setOverKey(key);
      },
      onDragLeave: () => setOverKey((k) => (k === key ? null : k)),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        const id = e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData("text/plain") || dragId;
        setDragId(null);
        setOverKey(null);
        const post = posts.find((p) => p.id === id);
        if (post) void moveTo(post, dropInstant(post.scheduledAt, day, hour, tz));
      },
    };
  }

  const title = view === "week" ? `${days[0]} — ${days[6]}` : `${MONTHS[month0]} ${year}`;
  const dated = view === "month" || view === "week";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-border p-0.5" role="tablist" aria-label="Ko'rinish">
          {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`rounded-md px-3 py-1 text-xs font-semibold ${view === v ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>
        {dated && (
          <div className="flex items-center gap-1">
            <button type="button" className={secondaryButton} onClick={() => shift(-1)} aria-label="Oldingi">
              ‹
            </button>
            <button type="button" className={secondaryButton} onClick={() => setAnchor(today)}>
              Bugun
            </button>
            <button type="button" className={secondaryButton} onClick={() => shift(1)} aria-label="Keyingi">
              ›
            </button>
            <span className="ml-2 text-sm font-semibold">{title}</span>
          </div>
        )}
        <select className={`${inputClass} !w-auto`} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Akkaunt">
          {view !== "grid" && <option value="">Barcha akkauntlar</option>}
          {meta.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.username}
            </option>
          ))}
        </select>
        {view !== "grid" && (
          <>
            <select className={`${inputClass} !w-auto`} value={type} onChange={(e) => setType(e.target.value)} aria-label="Tur">
              <option value="">Barcha turlar</option>
              {(Object.keys(TYPE_LABEL) as PostTypeValue[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <select className={`${inputClass} !w-auto`} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Holat">
              <option value="">Barcha holatlar</option>
              {(Object.keys(STATUS_LABEL) as PostStatusValue[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <select className={`${inputClass} !w-auto`} value={linked} onChange={(e) => setLinked(e.target.value)} aria-label="Kampaniya">
              <option value="">Kampaniya: hammasi</option>
              <option value="yes">Kampaniya ulangan</option>
              <option value="no">Kampaniyasiz</option>
            </select>
            <input className={`${inputClass} !w-48`} placeholder="Caption bo'yicha qidirish" value={q} onChange={(e) => setQ(e.target.value)} />
          </>
        )}
        {meta.accounts.length > 0 && (
          <button type="button" className={`${secondaryButton} ${slotsOpen ? "border-accent/60 text-foreground" : ""}`} aria-expanded={slotsOpen} onClick={() => setSlotsOpen((o) => !o)}>
            Slotlar
          </button>
        )}
        {quota && (
          <span className="ml-auto">
            <Pill tone={quota.used + quota.scheduledNext24h >= quota.total ? "error" : quota.used + quota.scheduledNext24h >= quota.total * 0.8 ? "warning" : "muted"}>
              24 soat: {quota.used + quota.scheduledNext24h}/{quota.total}
            </Pill>
          </span>
        )}
      </div>

      {failure && <Notice tone="error">{failure}</Notice>}
      {moveNote && (
        <Notice tone={moveNote.tone}>
          <span className="flex items-center justify-between gap-2">
            {moveNote.text}
            <button type="button" className="underline" onClick={() => setMoveNote(null)}>
              Yopish
            </button>
          </span>
        </Notice>
      )}
      {slotsOpen && <SlotsEditor meta={meta} accountId={account || undefined} onClose={() => setSlotsOpen(false)} />}

      {view === "grid" && <FeedGrid accountId={account || meta.accounts[0]?.id} tz={tz} refreshKey={refreshKey + reloadKey} onOpen={onOpen} />}

      {view === "list" && (
        <>
          {selected.size > 0 && (
            <BulkBar
              meta={meta}
              selected={[...selected]}
              onClear={() => setSelected(new Set())}
              onDone={(report) => {
                setBulkReport(report);
                setSelected(new Set(report.results.filter((r) => !r.ok).map((r) => r.id)));
                setReloadKey((k) => k + 1);
              }}
            />
          )}
          {bulkReport && <BulkResult report={bulkReport} posts={posts} tz={tz} onClose={() => setBulkReport(null)} />}
          <ListView
            posts={posts}
            tz={tz}
            me={me}
            selected={selected}
            onSelect={setSelected}
            onOpen={onOpen}
            onMoved={(id, scheduledAt) => {
              setPosts((list) => list.map((p) => (p.id === id ? { ...p, scheduledAt } : p)));
              setMoveNote({ tone: "info", text: scheduledAt ? `Ko'chirildi: ${formatZoned(new Date(scheduledAt), tz)}` : "Ko'chirildi" });
              setReloadKey((k) => k + 1);
            }}
          />
        </>
      )}

      {view === "month" && (
        <div className="overflow-x-auto">
          <div className="grid min-w-[700px] grid-cols-7 gap-1">
            {WEEKDAYS.map((d) => (
              <div key={d} className="label-mono px-1 py-1 text-[11px] font-semibold text-muted">
                {d}
              </div>
            ))}
            {days.map((day) => {
              const inMonth = day.slice(0, 7) === anchor.slice(0, 7);
              const list = byDay.get(day) ?? [];
              const past = day < today;
              return (
                <div
                  key={day}
                  role="button"
                  tabIndex={0}
                  onClick={() => !past && me.canCreate && onCreate(day)}
                  onKeyDown={(e) => e.key === "Enter" && !past && me.canCreate && onCreate(day)}
                  {...dropProps(day, day, null)}
                  className={`flex min-h-[108px] flex-col gap-1 rounded-lg border p-1.5 ${overKey === day ? "border-accent bg-accent/10" : "border-border"} ${inMonth ? "bg-surface" : "bg-surface/40 opacity-60"} ${day === today ? "ring-1 ring-accent/60" : ""} ${past ? "" : "hover:border-border-hover"}`}
                >
                  <span className={`text-xs ${day === today ? "font-bold text-accent" : "text-muted"}`}>{Number(day.slice(8, 10))}</span>
                  {list.map((p) => (
                    <PostChip key={p.id} post={p} tz={tz} onOpen={onOpen} dragging={dragId === p.id} {...dragProps(p)} />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === "week" && (
        <WeekGrid
          days={days}
          today={today}
          tz={tz}
          posts={posts}
          scores={best.data?.scores ?? null}
          overKey={overKey}
          dragId={dragId}
          canCreate={me.canCreate}
          onCreate={onCreate}
          onOpen={onOpen}
          dragProps={dragProps}
          dropProps={dropProps}
        />
      )}

      {view === "week" && best.data && (
        <p className="text-xs text-muted">
          {best.data.source === "none" ? (
            <>Eng yaxshi vaqt: {best.data.reason ?? "Ma'lumot yetarli emas"}</>
          ) : (
            <>
              Fon rangi — eng yaxshi vaqt ({BEST_TIMES_SOURCE_LABEL[best.data.source]}): {best.data.top.map(bestTimeLabel).join(", ")}
            </>
          )}
        </p>
      )}
      {view !== "grid" && (
        <p className="text-xs text-muted">
          Ranglar: <span className="text-primary">rejalashtirilgan</span> · <span className="text-success">chiqdi</span> · <span className="text-warning">qo&apos;lda / pauza</span> ·{" "}
          <span className="text-error">xato</span> · draftlar xira. Bo&apos;sh kunni bosib post yarating.
          {dated && (me.canCreate || me.canSchedule) && <> Rejalashtirilgan yoki draft kartani boshqa kunga sudrab ko&apos;chiring (telefonda — Ro&apos;yxat → Ko&apos;chirish).</>}
        </p>
      )}
    </div>
  );
}

type DragBindings = Partial<{ draggable: boolean; onDragStart: (e: DragEvent) => void; onDragEnd: () => void }>;
type DropBindings = Partial<{ onDragOver: (e: DragEvent) => void; onDragLeave: () => void; onDrop: (e: DragEvent) => void }>;

function WeekGrid({
  days,
  today,
  tz,
  posts,
  scores,
  overKey,
  dragId,
  canCreate,
  onCreate,
  onOpen,
  dragProps,
  dropProps,
}: {
  days: string[];
  today: string;
  tz: string;
  posts: PostCard[];
  scores: number[][] | null;
  overKey: string | null;
  dragId: string | null;
  canCreate: boolean;
  onCreate: (date: string) => void;
  onOpen: (id: string) => void;
  dragProps: (post: PostCard) => DragBindings;
  dropProps: (key: string, day: string, hour: number | null) => DropBindings;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Open on the working day, not on midnight.
    if (scroller.current) scroller.current.scrollTop = 8 * 44;
  }, []);

  const byCell = useMemo(() => {
    const map = new Map<string, PostCard[]>();
    for (const p of posts) {
      if (!p.scheduledAt) continue;
      const { date, time } = utcToZoned(new Date(p.scheduledAt), tz);
      const key = `${date}|${Number(time.slice(0, 2))}`;
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime());
    return map;
  }, [posts, tz]);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid grid-cols-[44px_repeat(7,minmax(0,1fr))] gap-1">
          <span />
          {days.map((day, i) => (
            <div key={day} className={`label-mono px-1 py-1 text-[11px] font-semibold ${day === today ? "text-accent" : "text-muted"}`}>
              {WEEKDAYS[i]} {Number(day.slice(8, 10))}
            </div>
          ))}
        </div>
        <div ref={scroller} className="max-h-[640px] overflow-y-auto rounded-lg border border-border">
          {HOURS.map((hour) => (
            <div key={hour} className="grid grid-cols-[44px_repeat(7,minmax(0,1fr))] gap-px border-b border-border/60 last:border-b-0">
              <span className="label-mono px-1 pt-1 text-[10px] text-muted">{String(hour).padStart(2, "0")}:00</span>
              {days.map((day, i) => {
                const key = `${day}|${hour}`;
                const list = byCell.get(key) ?? [];
                const past = day < today;
                return (
                  <div
                    key={key}
                    role="button"
                    tabIndex={-1}
                    aria-label={`${day} ${String(hour).padStart(2, "0")}:00`}
                    onClick={() => !past && canCreate && onCreate(day)}
                    {...dropProps(key, day, hour)}
                    className={`flex min-h-[44px] flex-col gap-0.5 p-0.5 ${overKey === key ? "bg-accent/20 ring-1 ring-inset ring-accent" : heatClass(scores?.[i]?.[hour])} ${past ? "opacity-60" : ""}`}
                  >
                    {list.map((p) => (
                      <PostChip key={p.id} post={p} tz={tz} onOpen={onOpen} dragging={dragId === p.id} {...dragProps(p)} />
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PostChip({ post, tz, onOpen, dragging, ...drag }: { post: PostCard; tz: string; onOpen: (id: string) => void; dragging?: boolean } & DragBindings) {
  const tone = postCardTone(post.status);
  const time = post.scheduledAt ? utcToZoned(new Date(post.scheduledAt), tz).time : "";
  return (
    <button
      type="button"
      {...drag}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(post.id);
      }}
      title={`${TYPE_LABEL[post.type]} · ${STATUS_LABEL[post.status]}${post.caption ? ` · ${post.caption}` : ""}${drag.draggable ? " · sudrab ko'chiring" : ""}`}
      className={`flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight ${TONE_CLASS[tone]} ${drag.draggable ? "cursor-grab active:cursor-grabbing" : ""} ${dragging ? "opacity-40" : ""}`}
    >
      {post.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
        <img src={post.thumbUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" draggable={false} />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-border text-xs">{TYPE_ICON[post.type]}</span>
      )}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{time}</span> {TYPE_LABEL[post.type]}
        {post.linked && <span className="ml-1 rounded bg-accent/20 px-1 text-[9px] font-bold text-accent">DM</span>}
        {!post.autoPublish && <span className="ml-1 text-[9px]">✋</span>}
        {post.seriesId && (
          <span className="ml-1 rounded bg-primary/20 px-1 text-[9px] font-bold text-primary" title="Seriya (story seriyasi yoki takroriy post)">
            S{(post.seriesIndex ?? 0) + 1}
          </span>
        )}
      </span>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[tone]}`} aria-hidden="true" />
    </button>
  );
}

function ListView({
  posts,
  tz,
  me,
  selected,
  onSelect,
  onOpen,
  onMoved,
}: {
  posts: PostCard[];
  tz: string;
  me: ContentMeta["me"];
  selected: Set<string>;
  onSelect: (next: Set<string>) => void;
  onOpen: (id: string) => void;
  onMoved: (id: string, scheduledAt: string | null) => void;
}) {
  const [moving, setMoving] = useState<string | null>(null);
  if (posts.length === 0) return <p className="text-sm text-muted">Hali post yo&apos;q.</p>;
  const selectable = me.canCreate;
  const allOn = posts.length > 0 && posts.every((p) => selected.has(p.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelect(next);
  };
  return (
    <div className="rounded-2xl border border-border bg-surface">
      {selectable && (
        <label className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={allOn} onChange={() => onSelect(allOn ? new Set() : new Set(posts.slice(0, 100).map((p) => p.id)))} />
          Hammasini tanlash{posts.length > 100 ? " (birinchi 100 ta)" : ""}
        </label>
      )}
      <ul className="divide-y divide-border">
        {posts.map((p) => {
          const tone = postCardTone(p.status);
          const when = p.scheduledAt ? utcToZoned(new Date(p.scheduledAt), tz) : null;
          const movable = canMovePost(p.status, me);
          return (
            <li key={p.id} className={selected.has(p.id) ? "bg-accent/5" : ""}>
              <div className="flex items-center gap-2 px-3 py-2">
                {selectable && <input type="checkbox" className="h-4 w-4 shrink-0 accent-accent" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label="Tanlash" />}
                <button type="button" onClick={() => onOpen(p.id)} className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left text-sm hover:bg-surface-hover">
                  {p.thumbUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                    <img src={p.thumbUrl} alt="" className="h-10 w-10 rounded object-cover" />
                  ) : (
                    <span className="flex h-10 w-10 items-center justify-center rounded bg-border">{TYPE_ICON[p.type]}</span>
                  )}
                  <span className="w-32 shrink-0 text-xs text-muted">{when ? `${when.date} ${when.time}` : "—"}</span>
                  <span className="hidden w-24 shrink-0 text-xs sm:inline">{TYPE_LABEL[p.type]}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{p.caption ?? ""}</span>
                  {p.linked && <span className="rounded bg-accent/20 px-1.5 text-[10px] font-bold text-accent">DM</span>}
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${TONE_CLASS[tone]}`}>{STATUS_LABEL[p.status]}</span>
                </button>
                {movable && (
                  <button type="button" className={`${secondaryButton} !px-2 !py-1 text-xs`} aria-expanded={moving === p.id} onClick={() => setMoving((m) => (m === p.id ? null : p.id))}>
                    Ko&apos;chirish
                  </button>
                )}
              </div>
              {moving === p.id && (
                <div className="px-3 pb-2">
                  <MoveForm
                    post={p}
                    tz={tz}
                    onCancel={() => setMoving(null)}
                    onDone={(scheduledAt) => {
                      setMoving(null);
                      onMoved(p.id, scheduledAt);
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
