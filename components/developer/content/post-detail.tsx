"use client";

/**
 * Post tafsiloti (spec §10.4): the status timeline, every publish attempt,
 * the explained error with its action (retry / manual / reconnect), the
 * permalink, the linked campaign, and the state buttons.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { explainError, RECONNECT_HREF } from "@/lib/foundation/error-catalog";
import { CONTENT_API, formatZoned, jsonInit, postCardTone, requestJson, STATUS_LABEL, TONE_CLASS, TYPE_LABEL, type ContentMeta, type PostDetail as Detail } from "./shared";

const TIMELINE: Array<{ key: string; label: string; reached: (p: Detail) => boolean }> = [
  { key: "created", label: "Yaratildi", reached: () => true },
  { key: "scheduled", label: "Rejalashtirildi", reached: (p) => Boolean(p.scheduledAt) && p.status !== "DRAFT" },
  { key: "preparing", label: "Tayyorlanmoqda", reached: (p) => ["PREPARING", "READY_TO_PUBLISH", "PUBLISHING", "PUBLISHED"].includes(p.status) },
  { key: "published", label: "Chiqdi", reached: (p) => p.status === "PUBLISHED" || p.status === "PUBLISHED_MANUAL" },
];

export default function PostDetail({
  meta,
  postId,
  refreshKey,
  onBack,
  onEdit,
  onChanged,
}: {
  meta: ContentMeta;
  postId: string;
  refreshKey: number;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [post, setPost] = useState<Detail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const res = await requestJson<Detail>(`${CONTENT_API}/posts/${postId}`);
    if (mine !== seq.current) return;
    if (res.ok) {
      setPost(res.data);
      setFailure(null);
    } else setFailure(res.error);
  }, [postId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch
    void load();
  }, [load, refreshKey]);

  // Live statuses refresh themselves while the worker is busy.
  useEffect(() => {
    if (!post || !["PREPARING", "READY_TO_PUBLISH", "PUBLISHING", "SCHEDULED"].includes(post.status)) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [post, load]);

  async function action(name: string, body: unknown = {}) {
    setBusy(name);
    setFailure(null);
    const res = name === "delete" ? await requestJson(`${CONTENT_API}/posts/${postId}`, { method: "DELETE" }) : await requestJson(`${CONTENT_API}/posts/${postId}/${name}`, jsonInit("POST", body));
    setBusy(null);
    if (!res.ok) return setFailure(res.error);
    onChanged();
    if (name === "delete") onBack();
    else void load();
  }

  if (failure && !post) {
    return (
      <div className="space-y-3">
        <button type="button" className={secondaryButton} onClick={onBack}>
          ‹ Kalendar
        </button>
        <Notice tone="error">{failure}</Notice>
      </div>
    );
  }
  if (!post) return <p className="text-sm text-muted">Yuklanmoqda…</p>;

  const tone = postCardTone(post.status);
  const explained = post.lastErrorCode ? explainError(`${post.lastErrorCode}: ${post.lastErrorMessage ?? ""}`) : null;
  const can = meta.me.canSchedule;
  const s = post.status;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={secondaryButton} onClick={onBack}>
          ‹ Kalendar
        </button>
        <h2 className="font-display text-lg font-bold">
          {TYPE_LABEL[post.type]} · @{post.accountUsername}
        </h2>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${TONE_CLASS[tone]}`}>{STATUS_LABEL[s]}</span>
        {post.scheduledAt && <span className="text-sm text-muted">{formatZoned(new Date(post.scheduledAt), post.timezone)}</span>}
        {post.linkedCampaign && <Pill tone={post.linkedCampaign.active ? "success" : "warning"}>DM: {post.linkedCampaign.name}{post.linkedCampaign.waiting ? " (post chiqishini kutmoqda)" : ""}</Pill>}
      </div>

      <ol className="flex flex-wrap gap-2 text-xs">
        {TIMELINE.map((step, i) => {
          const done = step.reached(post);
          return (
            <li key={step.key} className={`flex items-center gap-1 ${done ? "text-foreground" : "text-muted"}`}>
              <span className={`h-2 w-2 rounded-full ${done ? "bg-accent" : "bg-border"}`} aria-hidden="true" />
              {step.label}
              {i < TIMELINE.length - 1 && <span className="mx-1 text-border-hover">→</span>}
            </li>
          );
        })}
      </ol>

      {post.series && post.series.total > 1 && <SeriesBar post={post} canSchedule={can} canCreate={meta.me.canCreate} busy={busy !== null} onAction={(name) => void action(name)} />}

      {failure && <Notice tone="error">{failure}</Notice>}

      {explained && s !== "PUBLISHED" && (
        <div className="rounded-2xl border border-error/30 bg-error/10 p-4 text-sm">
          <p className="font-semibold text-error">{explained.problem}</p>
          <p className="mt-1 text-muted">{explained.cause}</p>
          <p className="mt-1">
            <span className="font-semibold">Nima qilish kerak:</span> {explained.solution}
          </p>
          {post.lastErrorMessage && <p className="mt-2 break-words text-[11px] text-muted">{post.lastErrorMessage}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {can && s === "FAILED" && (
              <button type="button" className={primaryButton} disabled={busy !== null} onClick={() => void action("retry")}>
                Qayta urinish
              </button>
            )}
            {explained.action.kind === "reconnect" && (
              <a className={secondaryButton} href={RECONNECT_HREF.replace("/developer/foundation", "/developer/content")}>
                Akkauntni qayta ulash
              </a>
            )}
          </div>
        </div>
      )}
      {s === "PUBLISHED" && post.firstCommentStatus === "FAILED" && <Notice tone="warning">Post chiqdi, birinchi komment yozilmadi — Instagram ilovasida qo&apos;lda yozing.</Notice>}
      {s === "NEEDS_MANUAL" && (
        <Notice tone="warning">
          Bu post qo&apos;lda chiqariladi{meta.telegramConnected ? " — fayllar va caption Telegram'ga yuborildi." : " — Telegram ulanmagan: fayllarni quyidan yuklab oling, caption'dan nusxa oling."} Chiqargach «Chiqardim» ni bosing.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-3 rounded-2xl border border-border bg-surface p-4">
          <div className="flex flex-wrap gap-2">
            {post.media.map((m) => (
              <a key={m.id} href={m.previewUrl ?? undefined} target="_blank" rel="noreferrer" className="block h-24 w-24 overflow-hidden rounded-lg bg-background" title="Faylni ochish / yuklab olish">
                {m.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                  <img src={m.thumbUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center text-xs text-muted">{m.kind}</span>
                )}
              </a>
            ))}
          </div>
          {post.caption && (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="label-mono text-[11px] font-semibold text-muted">Caption</span>
                <button type="button" className={`${secondaryButton} !py-0.5 text-xs`} onClick={() => void navigator.clipboard?.writeText(post.caption ?? "")}>
                  Nusxa olish
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm">{post.caption}</p>
            </div>
          )}
          {post.firstComment && (
            <p className="text-xs text-muted">
              <span className="font-semibold text-foreground">Birinchi komment:</span> {post.firstComment} {post.firstCommentStatus ? `(${post.firstCommentStatus})` : ""}
            </p>
          )}
          {post.collaborators.length > 0 && <p className="text-xs text-muted">Hammualliflar: {post.collaborators.map((c) => `@${c}`).join(", ")}</p>}
          {post.permalink && (
            <a className="text-sm text-accent underline" href={post.permalink} target="_blank" rel="noreferrer">
              Instagram&apos;da ochish
            </a>
          )}
          {post.issues.length > 0 && (
            <Notice tone="warning">
              <ul className="list-disc pl-4">
                {post.issues.map((i, k) => (
                  <li key={k}>{i.message}</li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            {meta.me.canCreate && ["DRAFT", "SCHEDULED", "PAUSED", "FAILED", "NEEDS_MANUAL", "REJECTED", "EXPIRED_REVIEW", "CANCELED"].includes(s) && (
              <button type="button" className={secondaryButton} onClick={onEdit}>
                Tahrirlash
              </button>
            )}
            {can && (s === "SCHEDULED" || s === "READY_TO_PUBLISH") && (
              <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void action("pause")}>
                Pauza
              </button>
            )}
            {can && s === "PAUSED" && (
              <button type="button" className={primaryButton} disabled={busy !== null} onClick={() => void action("resume")}>
                Davom ettirish
              </button>
            )}
            {can && ["SCHEDULED", "PAUSED", "FAILED", "NEEDS_MANUAL"].includes(s) && (
              <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void action("unschedule")}>
                Draftga qaytarish
              </button>
            )}
            {can && ["DRAFT", "SCHEDULED", "PAUSED", "FAILED", "NEEDS_MANUAL"].includes(s) && (
              <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void action("cancel")}>
                Bekor qilish
              </button>
            )}
            {meta.me.canCreate && s === "NEEDS_MANUAL" && (
              <button type="button" className={primaryButton} disabled={busy !== null} onClick={() => void action("mark-published")}>
                Chiqardim
              </button>
            )}
            {meta.me.canCreate && (
              <button type="button" className={secondaryButton} disabled={busy !== null} onClick={() => void action("duplicate")}>
                Nusxa olish
              </button>
            )}
            {can && s !== "PUBLISHING" && (
              <button
                type="button"
                className={`${secondaryButton} text-error`}
                disabled={busy !== null}
                onClick={() => {
                  if (window.confirm("Postni o'chirasizmi? Instagram'dagi post (bo'lsa) o'chmaydi.")) void action("delete");
                }}
              >
                O&apos;chirish
              </button>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4">
          <h3 className="mb-2 text-sm font-semibold">Urinishlar</h3>
          {post.attemptsLog.length === 0 ? (
            <p className="text-xs text-muted">Hali urinish yo&apos;q.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {post.attemptsLog.map((a) => (
                <li key={a.id} className="flex gap-2">
                  <span className={`shrink-0 ${a.ok ? "text-success" : "text-error"}`}>{a.ok ? "✓" : "✗"}</span>
                  <span className="w-28 shrink-0 text-muted">{new Date(a.createdAt).toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span className="w-24 shrink-0 font-semibold">{a.step}</span>
                  <span className="min-w-0 break-words text-muted">
                    {a.message}
                    {a.durationMs != null ? ` · ${a.durationMs} ms` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** FR-C9 / FR-S8: "Seriya: 2/3" with a link to every item and the series-wide actions. */
function SeriesBar({ post, canSchedule, canCreate, busy, onAction }: { post: Detail; canSchedule: boolean; canCreate: boolean; busy: boolean; onAction: (name: string) => void }) {
  const series = post.series!;
  const ownIndex = series.items.find((x) => x.id === post.id)?.seriesIndex ?? 0;
  const later = series.items.filter((i) => i.seriesIndex > ownIndex && !["PUBLISHING", "PUBLISHED", "PUBLISHED_MANUAL"].includes(i.status));
  const drafts = series.items.filter((i) => i.id !== post.id && i.status === "DRAFT");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
      <span className="font-semibold text-foreground">
        Seriya: {series.position}/{series.total}
      </span>
      <ol className="flex flex-wrap gap-1">
        {series.items.map((item, i) => {
          const tone = TONE_CLASS[postCardTone(item.status)];
          const when = item.scheduledAt ? formatZoned(new Date(item.scheduledAt), post.timezone) : STATUS_LABEL[item.status];
          return (
            <li key={item.id}>
              {item.id === post.id ? (
                <span className={`rounded-md border px-1.5 py-0.5 font-semibold ring-1 ring-accent/60 ${tone}`} aria-current="page">
                  {i + 1} · {when}
                </span>
              ) : (
                <Link href={`/developer/content?tab=calendar&post=${item.id}`} className={`rounded-md border px-1.5 py-0.5 hover:underline ${tone}`} title={STATUS_LABEL[item.status]}>
                  {i + 1} · {when}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
      <span className="ml-auto flex flex-wrap gap-1">
        {canCreate && drafts.length > 0 && ["DRAFT", "SCHEDULED", "PAUSED"].includes(post.status) && (
          <button type="button" className={`${secondaryButton} !py-0.5 text-xs`} disabled={busy} onClick={() => onAction("apply-to-series")} title="Matn va sozlamalar seriyaning draft nusxalariga ko'chiriladi">
            Matnni seriyaga qo&apos;llash ({drafts.length})
          </button>
        )}
        {canSchedule && later.length > 0 && (
          <button
            type="button"
            className={`${secondaryButton} !py-0.5 text-xs text-error`}
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Seriyaning keyingi ${later.length} ta nusxasi o'chirilsinmi?`)) onAction("delete-series-future");
            }}
          >
            Keyingi nusxalarni o&apos;chirish ({later.length})
          </button>
        )}
      </span>
    </div>
  );
}
