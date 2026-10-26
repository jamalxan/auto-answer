"use client";

/**
 * Kontent reja (ETAP 13 Content Scheduler, in the main dashboard at /content).
 * One /meta call feeds every tab (accounts, campaigns to link, role flags,
 * limits, storage, Telegram). The tab, the open post and the composer live
 * in the URL (?tab= &post= &new=1 &date=) so a link opens the right screen.
 * "Reja" — the timeline of everything planned — is the default tab.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { ServerOffNotice } from "@/components/developer/server-off";
import { PageHeader } from "@/components/ui/page";
import CalendarView from "./calendar-view";
import Composer from "./composer";
import CsvImport from "./csv-import";
import MediaLibrary from "./media-library";
import PostDetail from "./post-detail";
import QueueCard from "./queue-card";
import { ReviewsPanel } from "./reviews";
import SavedTexts from "./saved-texts";
import { CONTENT_API, requestJson, type ContentMeta } from "./shared";
import TimelineView from "./timeline-view";
import { limeButton, secondaryButton } from "./ui";

const TABS = [
  ["plan", "Reja"],
  ["calendar", "Kalendar"],
  ["library", "Kutubxona"],
  ["texts", "Shablonlar"],
  ["import", "Import"],
  ["reviews", "Tasdiqlar"],
] as const;
export type ContentTab = (typeof TABS)[number][0];

export interface ContentNavigate {
  (next: { tab?: ContentTab; post?: string | null; creating?: boolean; date?: string | null; edit?: boolean }): void;
}

export default function ContentDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: ContentTab = TABS.some(([key]) => key === tabParam) ? (tabParam as ContentTab) : "plan";
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

  // The composer and the post screen open over the plan or the calendar (whichever the user came from).
  const host: ContentTab = tab === "calendar" ? "calendar" : "plan";

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
    router.replace(`/content?${params.toString()}`, { scroll: false });
  };

  const bump = () => setRefreshKey((k) => k + 1);
  const overlay = (tab === "plan" || tab === "calendar") && (creating || Boolean(postParam));

  return (
    <div className="space-y-5">
      <PageHeader
        description="Post, karusel, Reels va Story'larni oldindan rejalashtiring — hammasi bitta oynada, kun va soat bo'yicha. Post chiqishi bilan unga comment-to-DM kampaniyasi ulanadi."
        actions={
          meta?.me.canCreate && !overlay ? (
            <>
              <button type="button" className={secondaryButton} onClick={() => navigate({ tab: "library" })}>
                Fayl yuklash
              </button>
              <button type="button" className={limeButton} onClick={() => navigate({ tab: host, creating: true })}>
                + Yangi post
              </button>
            </>
          ) : null
        }
      />

      {failure === "MODULE_OFF" && (
        <ServerOffNotice
          what="Kontent reja ishlamayapti: postlar rejalashtirilmaydi va chiqarilmaydi."
          ops={<>CONTENT_SCHEDULER_DISABLED=1 o&apos;rnatilgan. Worker va web&apos;ni bu env&apos;siz qayta ishga tushiring.</>}
        />
      )}
      {failure && failure !== "MODULE_OFF" && <Notice tone="error">{failure}</Notice>}

      {meta && (
        <>
          {meta.accounts.length === 0 && (
            <Notice tone="warning">
              Hali Instagram akkaunt ulanmagan —{" "}
              <a className="underline" href="/api/instagram/connect?return=/content">
                akkauntni ulang
              </a>
              .
            </Notice>
          )}
          {meta.accounts.some((a) => !a.canPublish) && (
            <Notice tone="warning">
              {meta.accounts.filter((a) => !a.canPublish).map((a) => `@${a.username}`).join(", ")}: post chiqarish ruxsati yo&apos;q — akkauntni qayta ulang (yangi ruxsat so&apos;raladi).{" "}
              <a className="underline" href="/api/instagram/connect?return=/content">
                Qayta ulash
              </a>
              . Ungacha postlar qo&apos;lda e&apos;lon rejimida ishlaydi: vaqti kelganda media va caption sizga yuboriladi.
            </Notice>
          )}
          {!meta.storage.configured && <Notice tone="error">Media ombori sozlanmagan — fayl yuklash ishlamaydi.</Notice>}

          <nav className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="Bo'limlar">
            {TABS.map(([key, label]) => (
              <button key={key} type="button" onClick={() => navigate({ tab: key })} className={`chip shrink-0 ${tab === key ? "chip-active" : ""}`} aria-current={tab === key ? "page" : undefined}>
                {label}
              </button>
            ))}
            <span className="ml-auto hidden shrink-0 items-center gap-3 pl-2 text-xs text-muted md:flex">
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${meta.telegramConnected ? "bg-lime" : "bg-muted"}`} aria-hidden="true" />
                {meta.telegramConnected ? "Telegram ulangan" : "Telegram ulanmagan"}
              </span>
              <span>{meta.me.roleLabel}</span>
            </span>
          </nav>

          {overlay && creating && (
            <Composer meta={meta} initialDate={dateParam} onClose={() => navigate({ creating: false })} onSaved={(id) => { bump(); navigate({ post: id, creating: false }); }} />
          )}
          {overlay && postParam && editing && (
            <Composer meta={meta} postId={postParam} onClose={() => navigate({ post: postParam })} onSaved={() => { bump(); navigate({ post: postParam }); }} />
          )}
          {overlay && postParam && !editing && (
            <PostDetail meta={meta} postId={postParam} refreshKey={refreshKey} onBack={() => navigate({ post: null })} onEdit={() => navigate({ post: postParam, edit: true })} onChanged={bump} />
          )}

          {!overlay && (tab === "plan" || tab === "calendar") && <QueueCard timezone={meta.timezone} refreshKey={refreshKey} />}
          {!overlay && tab === "plan" && <TimelineView meta={meta} refreshKey={refreshKey} onOpen={(id) => navigate({ post: id })} onCreate={(date) => navigate({ creating: true, date })} />}
          {!overlay && tab === "calendar" && (
            <CalendarView meta={meta} refreshKey={refreshKey} onOpen={(id) => navigate({ post: id })} onCreate={(date) => navigate({ creating: true, date })} />
          )}
          {tab === "library" && <MediaLibrary meta={meta} />}
          {tab === "texts" && <SavedTexts meta={meta} onChanged={load} />}
          {tab === "import" && <CsvImport meta={meta} onImported={bump} />}
          {tab === "reviews" && <ReviewsPanel meta={meta} refreshKey={refreshKey} onOpen={(id) => navigate({ tab: "plan", post: id })} onChanged={bump} />}
        </>
      )}

      {loading && !meta && (
        <div className="space-y-4" aria-hidden="true">
          <div className="panel h-24 animate-pulse rounded-3xl" />
          <div className="panel h-64 animate-pulse rounded-3xl" />
        </div>
      )}
    </div>
  );
}
