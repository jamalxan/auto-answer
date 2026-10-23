"use client";

/**
 * ETAP 13 — Content Scheduler, the developer screen. One /meta call feeds
 * every tab (accounts, campaigns to link, role flags, limits, storage,
 * Telegram). The tab, the open post and the composer live in the URL
 * (?tab= &post= &new=1 &date=) so a link opens the right screen.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { ServerOffNotice } from "@/components/developer/server-off";
import { DevBadge, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import CalendarView from "./calendar-view";
import Composer from "./composer";
import CsvImport from "./csv-import";
import MediaLibrary from "./media-library";
import PostDetail from "./post-detail";
import QueueCard from "./queue-card";
import SavedTexts from "./saved-texts";
import { CONTENT_API, requestJson, type ContentMeta } from "./shared";

const TABS = [
  ["calendar", "Kalendar"],
  ["library", "Kutubxona"],
  ["texts", "Shablonlar"],
  ["import", "Import"],
] as const;
export type ContentTab = (typeof TABS)[number][0];

export interface ContentNavigate {
  (next: { tab?: ContentTab; post?: string | null; creating?: boolean; date?: string | null; edit?: boolean }): void;
}

export default function ContentDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: ContentTab = TABS.some(([key]) => key === tabParam) ? (tabParam as ContentTab) : "calendar";
  const postParam = searchParams.get("post");
  const creating = searchParams.get("new") === "1";
  const editing = searchParams.get("edit") === "1";
  const dateParam = searchParams.get("date");

  const [meta, setMeta] = useState<ContentMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setFailure(null);
    try {
      const res = await requestJson<ContentMeta>(`${CONTENT_API}/meta`);
      if (mine !== seq.current) return;
      if (res.ok) setMeta(res.data);
      else setFailure(res.status === 404 ? "MODULE_OFF" : res.error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  const navigate: ContentNavigate = (next) => {
    const params = new URLSearchParams();
    const nextTab = next.tab ?? tab;
    params.set("tab", nextTab);
    const post = next.post === undefined ? (next.tab && next.tab !== tab ? null : postParam) : next.post;
    const wantsNew = next.creating === undefined ? (next.tab && next.tab !== tab ? false : creating && !post) : next.creating;
    if (post) {
      params.set("post", post);
      if (next.edit) params.set("edit", "1");
    } else if (wantsNew) {
      params.set("new", "1");
      if (next.date) params.set("date", next.date);
    }
    router.replace(`/developer/content?${params.toString()}`, { scroll: false });
  };

  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-extrabold">
            Content Scheduler <DevBadge />
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Post, karusel, Reels va Story&apos;ni oldindan rejalashtiring. Post chiqishi bilan unga comment-to-DM kampaniyasi ulanadi.
          </p>
        </div>
        {meta?.me.canCreate && !creating && !postParam && (
          <button type="button" className={primaryButton} onClick={() => navigate({ tab: "calendar", creating: true })}>
            + Post yaratish
          </button>
        )}
      </div>

      {failure === "MODULE_OFF" && (
        <ServerOffNotice
          what="Content Scheduler ishlamayapti: postlar rejalashtirilmaydi va chiqarilmaydi."
          ops={<>CONTENT_SCHEDULER_DISABLED=1 o&apos;rnatilgan yoki developer sessiyasi yo&apos;q. Worker va web&apos;ni env&apos;siz qayta ishga tushiring.</>}
        />
      )}
      {failure && failure !== "MODULE_OFF" && <Notice tone="error">{failure}</Notice>}

      {meta && (
        <>
          {meta.accounts.length === 0 && <Notice tone="warning">Hali Instagram akkaunt ulanmagan — avval Foundation bo&apos;limida ulang.</Notice>}
          {meta.accounts.some((a) => !a.canPublish) && (
            <Notice tone="warning">
              {meta.accounts.filter((a) => !a.canPublish).map((a) => `@${a.username}`).join(", ")}: post chiqarish ruxsati yo&apos;q — akkauntni qayta ulang (yangi ruxsat so&apos;raladi).{" "}
              <a className="underline" href="/api/instagram/connect?return=/developer/content">
                Qayta ulash
              </a>
              . Ungacha composer faqat draft va qo&apos;lda e&apos;lon rejimida ishlaydi.
            </Notice>
          )}
          {!meta.storage.configured && <Notice tone="error">Media ombori sozlanmagan (MEDIA_S3_* yoki lokal driver) — yuklash ishlamaydi.</Notice>}

          <nav className="flex flex-wrap gap-2" aria-label="Bo'limlar">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => navigate({ tab: key })}
                className={`${secondaryButton} ${tab === key ? "border-accent/60 text-foreground" : ""}`}
                aria-current={tab === key ? "page" : undefined}
              >
                {label}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-2 text-xs text-muted">
              <Pill tone={meta.telegramConnected ? "success" : "muted"}>{meta.telegramConnected ? "Telegram ulangan" : "Telegram ulanmagan"}</Pill>
              <span>{meta.me.roleLabel}</span>
            </span>
          </nav>

          {tab === "calendar" && creating && (
            <Composer meta={meta} initialDate={dateParam} onClose={() => navigate({ creating: false })} onSaved={(id) => { bump(); navigate({ post: id, creating: false }); }} />
          )}
          {tab === "calendar" && postParam && editing && (
            <Composer meta={meta} postId={postParam} onClose={() => navigate({ post: postParam })} onSaved={() => { bump(); navigate({ post: postParam }); }} />
          )}
          {tab === "calendar" && postParam && !editing && (
            <PostDetail meta={meta} postId={postParam} refreshKey={refreshKey} onBack={() => navigate({ post: null })} onEdit={() => navigate({ post: postParam, edit: true })} onChanged={bump} />
          )}
          {tab === "calendar" && !creating && !postParam && <QueueCard timezone={meta.timezone} refreshKey={refreshKey} />}
          {tab === "calendar" && !creating && !postParam && (
            <CalendarView meta={meta} refreshKey={refreshKey} onOpen={(id) => navigate({ post: id })} onCreate={(date) => navigate({ creating: true, date })} />
          )}
          {tab === "library" && <MediaLibrary meta={meta} />}
          {tab === "texts" && <SavedTexts meta={meta} onChanged={load} />}
          {tab === "import" && <CsvImport meta={meta} onImported={bump} />}
        </>
      )}

      {loading && !meta && <p className="text-sm text-muted">Yuklanmoqda…</p>}
    </div>
  );
}
