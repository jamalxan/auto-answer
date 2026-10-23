"use client";

/**
 * Month / week / list of scheduled posts (spec §10.1). Cards: thumbnail, type
 * mark, time, status colour, "DM" when a campaign is linked. An empty day
 * cell opens the composer on that date. The quota pill reads the account's
 * real 24-hour quota.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { inputClass, Pill, secondaryButton } from "@/components/developer/ui";
import {
  CONTENT_API,
  DOT_CLASS,
  groupPostsByDay,
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
  type ContentMeta,
  type PostCard,
  type PostStatusValue,
  type PostTypeValue,
} from "./shared";
import SlotsEditor from "./slots-editor";

type View = "month" | "week" | "list";

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
  const seq = useRef(0);

  const [year, month0] = [Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 1];
  const days = useMemo(() => (view === "week" ? weekOf(anchor) : monthGrid(year, month0)), [view, anchor, year, month0]);

  const load = useCallback(async () => {
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
  }, [load, refreshKey]);

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
  }, [quotaAccount, refreshKey]);

  const byDay = useMemo(() => groupPostsByDay(posts, tz), [posts, tz]);

  function shift(delta: number) {
    if (view === "week") {
      const d = new Date(`${anchor}T00:00:00Z`);
      setAnchor(new Date(d.getTime() + delta * 7 * 86_400_000).toISOString().slice(0, 10));
    } else {
      const d = new Date(Date.UTC(year, month0 + delta, 1));
      setAnchor(d.toISOString().slice(0, 10));
    }
  }

  const title = view === "week" ? `${days[0]} — ${days[6]}` : `${MONTHS[month0]} ${year}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {(["month", "week", "list"] as View[]).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={`rounded-md px-3 py-1 text-xs font-semibold ${view === v ? "bg-accent text-background" : "text-muted hover:text-foreground"}`}>
              {v === "month" ? "Oy" : v === "week" ? "Hafta" : "Ro'yxat"}
            </button>
          ))}
        </div>
        {view !== "list" && (
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
          <option value="">Barcha akkauntlar</option>
          {meta.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.username}
            </option>
          ))}
        </select>
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
      {slotsOpen && <SlotsEditor meta={meta} accountId={account || undefined} onClose={() => setSlotsOpen(false)} />}

      {view === "list" ? (
        <ListView posts={posts} tz={tz} onOpen={onOpen} />
      ) : (
        <div className="overflow-x-auto">
          <div className={`grid min-w-[700px] grid-cols-7 gap-1 ${view === "week" ? "" : ""}`}>
            {WEEKDAYS.map((d) => (
              <div key={d} className="label-mono px-1 py-1 text-[11px] font-semibold text-muted">
                {d}
              </div>
            ))}
            {days.map((day) => {
              const inMonth = view === "week" || day.slice(0, 7) === anchor.slice(0, 7);
              const list = byDay.get(day) ?? [];
              const past = day < today;
              return (
                <div
                  key={day}
                  role="button"
                  tabIndex={0}
                  onClick={() => !past && meta.me.canCreate && onCreate(day)}
                  onKeyDown={(e) => e.key === "Enter" && !past && meta.me.canCreate && onCreate(day)}
                  className={`flex ${view === "week" ? "min-h-[320px]" : "min-h-[108px]"} flex-col gap-1 rounded-lg border border-border p-1.5 ${inMonth ? "bg-surface" : "bg-surface/40 opacity-60"} ${day === today ? "ring-1 ring-accent/60" : ""} ${past ? "" : "hover:border-border-hover"}`}
                >
                  <span className={`text-xs ${day === today ? "font-bold text-accent" : "text-muted"}`}>{Number(day.slice(8, 10))}</span>
                  {list.map((p) => (
                    <PostChip key={p.id} post={p} tz={tz} onOpen={onOpen} />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <p className="text-xs text-muted">
        Ranglar: <span className="text-primary">rejalashtirilgan</span> · <span className="text-success">chiqdi</span> · <span className="text-warning">qo&apos;lda / pauza</span> ·{" "}
        <span className="text-error">xato</span> · draftlar xira. Bo&apos;sh kunni bosib post yarating.
      </p>
    </div>
  );
}

function PostChip({ post, tz, onOpen }: { post: PostCard; tz: string; onOpen: (id: string) => void }) {
  const tone = postCardTone(post.status);
  const time = post.scheduledAt ? utcToZoned(new Date(post.scheduledAt), tz).time : "";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(post.id);
      }}
      title={`${TYPE_LABEL[post.type]} · ${STATUS_LABEL[post.status]}${post.caption ? ` · ${post.caption}` : ""}`}
      className={`flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-left text-[11px] leading-tight ${TONE_CLASS[tone]}`}
    >
      {post.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
        <img src={post.thumbUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
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

function ListView({ posts, tz, onOpen }: { posts: PostCard[]; tz: string; onOpen: (id: string) => void }) {
  if (posts.length === 0) return <p className="text-sm text-muted">Hali post yo&apos;q.</p>;
  return (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
      {posts.map((p) => {
        const tone = postCardTone(p.status);
        const when = p.scheduledAt ? utcToZoned(new Date(p.scheduledAt), tz) : null;
        return (
          <li key={p.id}>
            <button type="button" onClick={() => onOpen(p.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-hover">
              {p.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                <img src={p.thumbUrl} alt="" className="h-10 w-10 rounded object-cover" />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded bg-border">{TYPE_ICON[p.type]}</span>
              )}
              <span className="w-32 shrink-0 text-xs text-muted">{when ? `${when.date} ${when.time}` : "—"}</span>
              <span className="w-24 shrink-0 text-xs">{TYPE_LABEL[p.type]}</span>
              <span className="min-w-0 flex-1 truncate text-muted">{p.caption ?? ""}</span>
              {p.linked && <span className="rounded bg-accent/20 px-1.5 text-[10px] font-bold text-accent">DM</span>}
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${TONE_CLASS[tone]}`}>{STATUS_LABEL[p.status]}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
