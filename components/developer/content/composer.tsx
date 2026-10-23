"use client";

/**
 * Post muharriri (spec §10.2, FR-C1…FR-C13). Form on the left in the spec's
 * order — account and type, media, caption, advanced, automation, time —
 * the live Instagram preview on the right (stacked on a phone). The field
 * matrix decides what is shown; the server's /validate call adds the issues
 * the client cannot know (ratios, durations, ownership). A draft is backed
 * up to localStorage every 5 s and, once it exists on the server, PATCHed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { ChipInput, Field, inputClass, Pill, primaryButton, secondaryButton, Toggle } from "@/components/developer/ui";
import { EDITABLE } from "@/lib/content/transitions";
import { MediaPicker, UploadZone } from "./media-library";
import Preview from "./preview";
import {
  composerBlocked,
  composerButtonLabel,
  CONTENT_API,
  countCaption,
  defaultSlot,
  draftOfDetail,
  draftToBody,
  emptyDraft,
  fieldVisible,
  formatDuration,
  jsonInit,
  mediaRule,
  requestJson,
  STATUS_LABEL,
  tagCoords,
  typeForMedia,
  TYPE_LABEL,
  utcToZoned,
  zonedToUtc,
  type ComposerMode,
  type ContentMeta,
  type MediaItemDraft,
  type MediaRow,
  type PostDetail,
  type PostDraft,
  type PostTypeValue,
} from "./shared";
import TagEditor from "./tag-editor";
import RecurrenceFields, { emptyRecur, recurBody, recurPreview, type RecurState } from "./recurrence-fields";
import { formatZoned, storySeriesLabel } from "./shared";
import CropEditor, { presetsFor } from "./crop-editor";
import { centerCrop, type CropRect } from "@/lib/content/crop-geometry";

const TYPE_CHOICES: PostTypeValue[] = ["FEED_IMAGE", "CAROUSEL", "REEL", "TRIAL_REEL", "STORY"];
const AUTOSAVE_MS = 5_000;
const VALIDATE_DEBOUNCE_MS = 600;

interface Issue {
  field: string;
  message: string;
}

type Slot = { date: string; time: string };

function backupKey(postId?: string) {
  return `content-composer:${postId ?? "new"}`;
}

function readBackup(postId?: string): PostDraft | null {
  try {
    const raw = window.localStorage.getItem(backupKey(postId));
    return raw ? (JSON.parse(raw) as PostDraft) : null;
  } catch {
    return null;
  }
}

function writeBackup(postId: string | undefined, draft: PostDraft | null) {
  try {
    if (draft) window.localStorage.setItem(backupKey(postId), JSON.stringify(draft));
    else window.localStorage.removeItem(backupKey(postId));
  } catch {
    /* private mode — the server copy is the record */
  }
}

/** The API body: client-only fields stripped, an empty automation card sent as "no link". */
function bodyOf(draft: PostDraft) {
  const body = draftToBody(draft);
  const link = draft.linkCampaign;
  return { ...body, linkCampaign: link && (link.automationId || link.triggerCampaignId) ? link : null };
}

function rowToItem(row: Pick<MediaRow, "id" | "kind" | "status" | "thumbUrl" | "width" | "height" | "durationMs">): MediaItemDraft {
  return { mediaId: row.id, kind: row.kind, status: row.status, thumbUrl: row.thumbUrl, previewUrl: row.thumbUrl, width: row.width, height: row.height, durationMs: row.durationMs, userTags: [] };
}

export default function Composer({
  meta,
  postId,
  initialDate,
  onClose,
  onSaved,
}: {
  meta: ContentMeta;
  postId?: string;
  initialDate?: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const tz = meta.timezone;
  const firstAccount = meta.accounts[0]?.id ?? "";
  const [draft, setDraft] = useState<PostDraft>(() => emptyDraft(firstAccount));
  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(postId));
  const [mode, setMode] = useState<ComposerMode>("schedule");
  const [slot, setSlot] = useState<Slot>(() => defaultSlot(initialDate ?? null, tz));
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [autosavedAt, setAutosavedAt] = useState<string | null>(null);
  const [picker, setPicker] = useState<"media" | "cover" | null>(null);
  const [tagging, setTagging] = useState<number | null>(null);
  const [cropping, setCropping] = useState<number | null>(null);
  const [advanced, setAdvanced] = useState(false);
  // Faza 2: recurrence (FR-S8) and the account's posting slots (FR-S9).
  const [recur, setRecur] = useState<RecurState>(() => emptyRecur(slot.date));
  const [recurReport, setRecurReport] = useState<{ id: string; total: number; failed: Array<{ seriesIndex: number; at: string; error: string }> } | null>(null);
  const [slotCount, setSlotCount] = useState(0);
  const dirty = useRef(false);
  const serverId = useRef<string | undefined>(postId);
  const versionRef = useRef<number | null>(null);

  const account = meta.accounts.find((a) => a.id === draft.instagramAccountId) ?? null;
  const canPublish = Boolean(account?.canPublish);
  const canSchedule = meta.me.canSchedule;
  const rules = mediaRule(draft.type);
  const mediaMax = rules.max === "carousel" ? meta.limits.carouselMax : rules.max;
  const caption = countCaption(draft.caption);
  const comment = countCaption(draft.firstComment);
  const blocked = composerBlocked(draft, meta.limits);
  const locked = Boolean(detail && !EDITABLE.includes(detail.status));
  const at = useMemo(() => {
    if (mode !== "schedule" || !/^\d{4}-\d{2}-\d{2}$/.test(slot.date) || !/^\d{2}:\d{2}$/.test(slot.time)) return null;
    try {
      return zonedToUtc(slot.date, slot.time, tz);
    } catch {
      return null;
    }
  }, [mode, slot, tz]);

  const update = useCallback((patch: Partial<PostDraft> | ((d: PostDraft) => PostDraft)) => {
    dirty.current = true;
    setDraft((d) => (typeof patch === "function" ? patch(d) : { ...d, ...patch }));
  }, []);

  // ── load (edit) or restore (new) ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!postId) {
      const backup = readBackup();
      if (backup && (backup.media.length || backup.caption)) {
        /* eslint-disable react-hooks/set-state-in-effect -- restore once on open */
        setDraft({ ...backup, instagramAccountId: meta.accounts.some((a) => a.id === backup.instagramAccountId) ? backup.instagramAccountId : firstAccount });
        setNotice("Oldingi saqlanmagan draft tiklandi");
        /* eslint-enable react-hooks/set-state-in-effect */
      }
      return;
    }
    (async () => {
      const res = await requestJson<PostDetail>(`${CONTENT_API}/posts/${postId}`);
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error);
        setLoading(false);
        return;
      }
      setDetail(res.data);
      versionRef.current = res.data.version;
      setDraft(draftOfDetail(res.data));
      if (res.data.scheduledAt) {
        setSlot(utcToZoned(new Date(res.data.scheduledAt), tz));
        setMode(res.data.status === "DRAFT" ? "draft" : "schedule");
      } else setMode("draft");
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [postId, tz, meta.accounts, firstAccount]);

  // ── the account without the publish scope works in manual mode only ────
  useEffect(() => {
    if (account && !canPublish && draft.autoPublish) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- derived constraint
      setDraft((d) => ({ ...d, autoPublish: false, manualReason: d.manualReason ?? "USER_CHOICE" }));
    }
  }, [account, canPublish, draft.autoPublish]);

  // ── FR-S9: "Navbatga qo'shish" shows only when the account has slots ───
  useEffect(() => {
    if (!canSchedule || !draft.instagramAccountId) return;
    let alive = true;
    void requestJson<{ slots: unknown[] }>(`${CONTENT_API}/accounts/${draft.instagramAccountId}/slots`).then((res) => {
      if (alive) setSlotCount(res.ok ? res.data.slots.length : 0);
    });
    return () => {
      alive = false;
    };
  }, [canSchedule, draft.instagramAccountId]);

  // ── live server validation ──────────────────────────────────────────────
  useEffect(() => {
    if (!draft.instagramAccountId || draft.media.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nothing to validate yet
      setIssues([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await requestJson<{ issues: Issue[] }>(`${CONTENT_API}/validate`, jsonInit("POST", bodyOf(draft)));
      if (res.ok) setIssues(res.data.issues);
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft]);

  // ── autosave: localStorage every 5 s; PATCH when the post exists ───────
  useEffect(() => {
    const t = setInterval(async () => {
      if (!dirty.current) return;
      dirty.current = false;
      writeBackup(serverId.current, draft);
      if (serverId.current && versionRef.current !== null && !locked && !blocked) {
        const res = await requestJson<PostDetail>(`${CONTENT_API}/posts/${serverId.current}`, jsonInit("PATCH", { ...bodyOf(draft), version: versionRef.current }));
        if (res.ok) {
          versionRef.current = res.data.version;
          setAutosavedAt(new Date().toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" }));
        }
      }
    }, AUTOSAVE_MS);
    return () => clearInterval(t);
  }, [draft, locked, blocked]);

  // ── media handlers ──────────────────────────────────────────────────────
  function addMedia(items: MediaItemDraft[]) {
    const fresh = items.filter((i) => !draft.media.some((m) => m.mediaId === i.mediaId));
    if (fresh.length === 0) return;
    const merged = [...draft.media, ...fresh];
    const type = typeForMedia(draft.type, merged.map((m) => m.kind ?? "IMAGE"));
    const rule = mediaRule(type);
    const max = rule.max === "carousel" ? meta.limits.carouselMax : rule.max;
    const media = merged.slice(0, max);
    if (type !== draft.type) setNotice(type === "FEED_VIDEO" ? "Video tanlandi — Instagram uni Reels sifatida chiqaradi" : type === "CAROUSEL" ? "Bir nechta fayl — post karuselga aylandi" : `Tur ${TYPE_LABEL[type]} ga o'zgardi`);
    else if (media.length < merged.length) setNotice(`Ko'pi bilan ${max} ta media — ortig'i olib tashlandi`);
    update({ type, media });
  }
  function removeMedia(index: number) {
    update((d) => ({ ...d, media: d.media.filter((_, i) => i !== index) }));
    setTagging(null);
    setCropping(null);
  }
  function moveMedia(index: number, dir: -1 | 1) {
    update((d) => {
      const next = [...d.media];
      const j = index + dir;
      if (j < 0 || j >= next.length) return d;
      [next[index], next[j]] = [next[j], next[index]];
      return { ...d, media: next };
    });
  }
  function patchItem(index: number, patch: Partial<MediaItemDraft>) {
    update((d) => ({ ...d, media: d.media.map((m, i) => (i === index ? { ...m, ...patch } : m)) }));
  }
  /** FR-M4: in a carousel the first item's ratio is everyone's — the others are re-centred on it. */
  function setCrop(index: number, rect: CropRect | null) {
    update((d) => {
      const first = index === 0 ? rect : (d.media[0]?.cropRect ?? null);
      const firstItem = d.media[0];
      const ratio = first && firstItem?.width && firstItem?.height ? (first.w * firstItem.width) / (first.h * firstItem.height) : null;
      return {
        ...d,
        media: d.media.map((m, i) => {
          if (i === index) return { ...m, cropRect: rect };
          if (d.type !== "CAROUSEL" || index !== 0 || m.kind === "VIDEO" || !m.width || !m.height) return m;
          return { ...m, cropRect: ratio ? centerCrop(m.width, m.height, ratio) : null };
        }),
      };
    });
  }

  function setType(type: PostTypeValue) {
    const rule = mediaRule(type);
    const kinds = rule.kinds as string[];
    const fitting = draft.media.filter((m) => kinds.includes(m.kind ?? "IMAGE"));
    const media = rule.max === "carousel" ? fitting : fitting.slice(0, rule.max);
    if (media.length !== draft.media.length) setNotice("Bu turga mos kelmagan media olib tashlandi");
    update({ type, media, caption: fieldVisible(type, "caption") ? draft.caption : "", trialStrategy: type === "TRIAL_REEL" ? (draft.trialStrategy ?? "MANUAL") : null });
  }

  function insertText(body: string, target: "caption" | "firstComment") {
    update((d) => ({ ...d, [target]: d[target] ? `${d[target].replace(/\s+$/, "")}\n\n${body}` : body }));
  }

  // ── automation card ─────────────────────────────────────────────────────
  const campaigns = meta.campaigns.filter((c) => c.instagramAccountId === draft.instagramAccountId && (!c.linkedPostId || c.linkedPostId === postId));
  const linkedId = draft.linkCampaign?.automationId ?? draft.linkCampaign?.triggerCampaignId ?? "";
  const linked = campaigns.find((c) => c.id === linkedId) ?? null;
  const keywordMissing = Boolean(linked && linked.keywords.length > 0 && fieldVisible(draft.type, "caption") && !linked.keywords.some((k) => draft.caption.toLowerCase().includes(k.toLowerCase())));

  // ── save ────────────────────────────────────────────────────────────────
  async function save(as: ComposerMode | "queue" = mode) {
    setSaving(true);
    setError(null);
    try {
      const body = bodyOf(draft);
      let saved: PostDetail;
      if (serverId.current) {
        const res = await requestJson<PostDetail>(`${CONTENT_API}/posts/${serverId.current}`, jsonInit("PATCH", { ...body, version: versionRef.current ?? 1 }));
        if (!res.ok) throw new Error(res.error);
        saved = res.data;
      } else {
        const res = await requestJson<PostDetail>(`${CONTENT_API}/posts`, jsonInit("POST", body));
        if (!res.ok) throw new Error(res.error);
        saved = res.data;
        serverId.current = saved.id;
      }
      versionRef.current = saved.version;
      if (as === "queue" || (as === "schedule" && canSchedule && recurring)) {
        // FR-S9 next free slot / FR-S8 recurrence: their own actions on the saved draft.
        const res =
          as === "queue"
            ? await requestJson<PostDetail>(`${CONTENT_API}/posts/${saved.id}/queue`, jsonInit("POST", {}))
            : await requestJson<{ total: number; failed: Array<{ seriesIndex: number; at: string; error: string }> }>(`${CONTENT_API}/posts/${saved.id}/recur`, jsonInit("POST", recurBody(recur, slot.date, slot.time)));
        if (!res.ok) {
          setNotice("Draft saqlandi, lekin rejalashtirilmadi");
          throw new Error(res.error);
        }
        if (as === "schedule" && "failed" in res.data && res.data.failed.length > 0) {
          writeBackup(postId, null);
          writeBackup(undefined, null);
          dirty.current = false;
          setRecurReport({ id: saved.id, total: res.data.total, failed: res.data.failed });
          return;
        }
      } else if (as !== "draft" && canSchedule) {
        const action = as === "now" ? "publish-now" : "schedule";
        const res = await requestJson<PostDetail>(`${CONTENT_API}/posts/${saved.id}/${action}`, jsonInit("POST", as === "now" ? {} : { scheduledAt: { date: slot.date, time: slot.time, timezone: tz } }));
        if (!res.ok) {
          setNotice("Draft saqlandi, lekin rejalashtirilmadi");
          throw new Error(res.error);
        }
      } else if (as !== "draft" && !canSchedule) {
        setNotice("Draft saqlandi. Tasdiqlash oqimi keyingi fazada — hozircha MANAGER kalendardan rejalashtiradi.");
      }
      writeBackup(postId, null);
      writeBackup(undefined, null);
      dirty.current = false;
      onSaved(saved.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Saqlanmadi");
    } finally {
      setSaving(false);
    }
  }

  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message ?? null;
  const mediaIssues = issues.filter((i) => i.field.startsWith("media"));
  const otherIssues = issues.filter((i) => !["caption", "collaborators", "firstComment", "scheduledAt"].includes(i.field) && !i.field.startsWith("media"));
  const storySeries = draft.type === "STORY" && draft.media.length > 1;
  const canRecur = canSchedule && mode === "schedule" && !storySeries && (!detail || detail.status === "DRAFT");
  const recurring = canRecur && recur.on;
  const recurInfo = recurPreview(recur, slot.date, slot.time, tz);
  const buttonLabel = recurring ? (recurInfo.error ? "Takrorlash sozlamasini tekshiring" : `${recurInfo.count} ta nusxani rejalashtirish`) : composerButtonLabel({ mode, at, tz, canSchedule });
  const disabled = saving || loading || locked || Boolean(blocked) || issues.length > 0 || !meta.me.canCreate || (recurring && Boolean(recurInfo.error));

  if (loading) return <p className="text-sm text-muted">Yuklanmoqda…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className={secondaryButton} onClick={onClose}>
          ‹ Orqaga
        </button>
        <div className="flex items-center gap-2 text-xs text-muted">
          {detail && <Pill tone="muted">{STATUS_LABEL[detail.status]}</Pill>}
          {autosavedAt && <span>Saqlandi {autosavedAt}</span>}
        </div>
      </div>

      {locked && <Notice tone="warning">Post {STATUS_LABEL[detail!.status].toLowerCase()} — bu holatda tahrirlab bo&apos;lmaydi.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {recurReport && (
        <Notice tone="warning">
          {recurReport.total - recurReport.failed.length}/{recurReport.total} nusxa rejalashtirildi. Rejalashtirilmaganlar draft bo&apos;lib seriyada qoldi:
          <ul className="mt-1 list-disc pl-4">
            {recurReport.failed.map((f) => (
              <li key={f.seriesIndex}>
                {formatZoned(new Date(f.at), tz)} — {f.error}
              </li>
            ))}
          </ul>
          <button type="button" className={`${secondaryButton} mt-2`} onClick={() => onSaved(recurReport.id)}>
            Postga o&apos;tish
          </button>
        </Notice>
      )}
      {notice && (
        <Notice tone="info">
          {notice}{" "}
          <button type="button" className="underline" onClick={() => setNotice(null)}>
            yopish
          </button>
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <fieldset disabled={locked} className="min-w-0 space-y-6">
          {/* 1. Akkaunt va tur */}
          <section className="space-y-3 rounded-2xl border border-border bg-surface p-4">
            <Field label="Akkaunt" error={account && !canPublish ? "Bu akkauntda post chiqarish ruxsati yo'q — faqat draft va qo'lda e'lon" : null}>
              <select className={inputClass} value={draft.instagramAccountId} onChange={(e) => update({ instagramAccountId: e.target.value, linkCampaign: null })} disabled={Boolean(postId)}>
                {meta.accounts.length === 0 && <option value="">Akkaunt ulanmagan</option>}
                {meta.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.username}
                    {a.tokenStatus !== "ACTIVE" ? " · ulanish uzilgan" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tur" hint={draft.type === "FEED_VIDEO" ? "Video post Instagram'da Reels sifatida chiqadi" : undefined}>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Post turi">
                {TYPE_CHOICES.map((t) => {
                  const on = draft.type === t || (t === "FEED_IMAGE" && draft.type === "FEED_VIDEO");
                  return (
                    <button key={t} type="button" role="radio" aria-checked={on} onClick={() => setType(t)} className={`${secondaryButton} ${on ? "border-accent/60 text-foreground" : ""}`}>
                      {TYPE_LABEL[t]}
                    </button>
                  );
                })}
              </div>
            </Field>
          </section>

          {/* 2. Media */}
          <section className="space-y-3 rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <span className="label-mono text-[11px] font-semibold text-muted">
                Media · {draft.media.length}/{mediaMax}
                {rules.kinds.length === 1 ? (rules.kinds[0] === "VIDEO" ? " · faqat video" : " · faqat rasm") : ""}
              </span>
              <button type="button" className={secondaryButton} onClick={() => setPicker("media")}>
                Kutubxonadan
              </button>
            </div>
            {draft.media.length < mediaMax && <UploadZone compact max={Math.max(1, mediaMax - draft.media.length)} onUploaded={(asset) => addMedia([rowToItem(asset)])} />}
            {draft.media.length > 0 && (
              <ol className="space-y-2">
                {draft.media.map((m, i) => {
                  const issue = issueFor(`media[${i}]`);
                  return (
                    <li key={m.mediaId} className={`rounded-xl border p-2 ${issue ? "border-error/50" : "border-border"}`}>
                      <div className="flex items-center gap-3">
                        <span className="w-5 text-center text-xs text-muted">{i + 1}</span>
                        <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-background">
                          {m.thumbUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                            <img src={m.thumbUrl} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <span className="flex h-full items-center justify-center text-muted">{m.kind === "VIDEO" ? "▶" : "▣"}</span>
                          )}
                          {m.kind === "VIDEO" && m.durationMs ? <span className="absolute bottom-0.5 right-0.5 rounded bg-background/80 px-1 text-[10px]">{formatDuration(m.durationMs)}</span> : null}
                        </span>
                        <div className="min-w-0 flex-1 text-xs text-muted">
                          {m.width && m.height ? `${m.width}×${m.height}` : m.kind}
                          {m.status && m.status !== "READY" && <span className="ml-2 text-warning">tayyorlanmoqda…</span>}
                          {m.userTags && m.userTags.length > 0 && <div className="truncate">Belgilangan: {m.userTags.map((t) => `@${t.username}`).join(", ")}</div>}
                          {issue && <div className="text-error">{issue}</div>}
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-1">
                          {draft.media.length > 1 && (
                            <>
                              <button type="button" className={`${secondaryButton} !px-2 !py-1`} aria-label="Yuqoriga" disabled={i === 0} onClick={() => moveMedia(i, -1)}>
                                ↑
                              </button>
                              <button type="button" className={`${secondaryButton} !px-2 !py-1`} aria-label="Pastga" disabled={i === draft.media.length - 1} onClick={() => moveMedia(i, 1)}>
                                ↓
                              </button>
                            </>
                          )}
                          {m.kind === "IMAGE" && m.width && m.height && (draft.type === "FEED_IMAGE" || draft.type === "CAROUSEL" || draft.type === "STORY") && (
                            <button
                              type="button"
                              className={`${secondaryButton} !px-2 !py-1 text-xs ${issue && /Kesing|Kesish/.test(issue) ? "!border-warning text-warning" : ""}`}
                              onClick={() => setCropping(cropping === i ? null : i)}
                              aria-expanded={cropping === i}
                            >
                              {m.cropRect ? "Kesildi" : "Kesish"}
                            </button>
                          )}
                          {fieldVisible(draft.type, "userTags") && (
                            <button type="button" className={`${secondaryButton} !px-2 !py-1 text-xs`} onClick={() => setTagging(tagging === i ? null : i)} aria-expanded={tagging === i}>
                              Odam belgilash
                            </button>
                          )}
                          <button type="button" className={`${secondaryButton} !px-2 !py-1`} aria-label="Olib tashlash" onClick={() => removeMedia(i)}>
                            ×
                          </button>
                        </div>
                      </div>
                      {cropping === i && m.width && m.height && (
                        <div className="mt-2">
                          <CropEditor
                            imageUrl={m.previewUrl ?? m.thumbUrl ?? null}
                            width={m.width}
                            height={m.height}
                            rect={m.cropRect ?? null}
                            presets={presetsFor(draft.type === "STORY")}
                            onChange={(rect) => setCrop(i, rect)}
                          />
                          {draft.type === "CAROUSEL" && i === 0 && <p className="mt-1 text-[11px] text-muted">Birinchi rasm nisbati boshqa rasmlarga ham qo&apos;llanadi.</p>}
                        </div>
                      )}
                      {tagging === i && (
                        <div className="mt-2">
                          <TagEditor imageUrl={m.kind === "IMAGE" ? (m.previewUrl ?? m.thumbUrl ?? null) : null} tags={m.userTags ?? []} coords={m.kind === "IMAGE" ? tagCoords(draft.type) : "optional"} onChange={(userTags) => patchItem(i, { userTags })} />
                        </div>
                      )}
                      {fieldVisible(draft.type, "altText") && m.kind === "IMAGE" && (
                        <input
                          className={`${inputClass} mt-2 !py-1 text-xs`}
                          placeholder={`Alt matn (${meta.limits.altTextChars} belgigacha) — ko'rish qiyin odamlar uchun tavsif`}
                          maxLength={meta.limits.altTextChars}
                          value={m.altText ?? ""}
                          onChange={(e) => patchItem(i, { altText: e.target.value })}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            {draft.type === "CAROUSEL" && draft.media.length > 1 && <p className="text-[11px] text-muted">Instagram barcha elementlarni birinchi elementning nisbatiga qirqadi.</p>}
            {storySeries && <p className="text-xs font-semibold text-foreground">{storySeriesLabel(draft.media.length, mode === "schedule" ? at : null, tz)} — har biri alohida story bo&apos;lib chiqadi.</p>}
            {mediaIssues.filter((i) => !/^media\[\d+\]$/.test(i.field)).map((i) => (
              <p key={i.field} className="text-xs text-error">
                {i.message}
              </p>
            ))}
          </section>

          {/* 3. Caption */}
          {fieldVisible(draft.type, "caption") && (
            <section className="space-y-3 rounded-2xl border border-border bg-surface p-4">
              <Field
                label="Caption"
                error={issueFor("caption") ?? (caption.chars > meta.limits.captionChars ? `Caption ${meta.limits.captionChars} belgidan oshdi` : null)}
                hint={keywordMissing ? `Caption'da "${linked!.keywords[0]} deb yozing" degan chaqiruv yo'q` : undefined}
              >
                <textarea className={`${inputClass} min-h-32`} value={draft.caption} onChange={(e) => update({ caption: e.target.value })} placeholder="Nima yozamiz? #hashtag va @mention ishlaydi" />
                <div className="flex flex-wrap gap-3 text-[11px]">
                  <Counter value={caption.chars} max={meta.limits.captionChars} label="belgi" />
                  <Counter value={caption.hashtags} max={meta.limits.hashtags} label="#" />
                  <Counter value={caption.mentions} max={meta.limits.mentions} label="@" />
                </div>
              </Field>
              {meta.savedTexts.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted">Hashtag guruhi / shablon qo&apos;shish</summary>
                  <ul className="mt-2 space-y-1">
                    {meta.savedTexts.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-semibold">{t.title}</span>
                        <button type="button" className={`${secondaryButton} !py-1`} onClick={() => insertText(t.body, "caption")}>
                          Caption&apos;ga
                        </button>
                        {fieldVisible(draft.type, "firstComment") && (
                          <button type="button" className={`${secondaryButton} !py-1`} onClick={() => insertText(t.body, "firstComment")}>
                            Kommentga
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}
          {draft.type === "STORY" && <p className="text-xs text-muted">Story&apos;da caption bo&apos;lmaydi — matn stikerlarini Instagram ilovasida qo&apos;shasiz (qo&apos;lda e&apos;lon rejimi).</p>}

          {/* 4. Kengaytirilgan */}
          <section className="rounded-2xl border border-border bg-surface p-4">
            <button type="button" className="flex w-full items-center justify-between text-left text-sm font-semibold" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
              Kengaytirilgan
              <span className="text-muted">{advanced ? "−" : "+"}</span>
            </button>
            {advanced && (
              <div className="mt-4 space-y-4">
                {fieldVisible(draft.type, "collaborators") && (
                  <Field label={`Hammualliflar (${draft.collaborators.length}/${meta.limits.maxCollaborators})`} error={issueFor("collaborators")} hint="Hammuallif Instagram ilovasida taklifni qabul qilishi kerak; qabul qilmasa post hamkorliksiz chiqadi; yopiq akkauntni qo'shib bo'lmaydi.">
                    <ChipInput values={draft.collaborators} onChange={(collaborators) => update({ collaborators: collaborators.map((c) => c.replace(/^@+/, "")) })} placeholder="@username, Enter" max={meta.limits.maxCollaborators} />
                  </Field>
                )}
                {fieldVisible(draft.type, "firstComment") && (
                  <Field label="Birinchi komment" error={issueFor("firstComment")} hint="Publishdan 10–30 soniya keyin akkaunt nomidan yoziladi — hashtaglar uchun qulay.">
                    <textarea className={`${inputClass} min-h-20`} value={draft.firstComment} onChange={(e) => update({ firstComment: e.target.value })} />
                    <div className="flex gap-3 text-[11px]">
                      <Counter value={comment.chars} max={meta.limits.firstCommentChars} label="belgi" />
                    </div>
                  </Field>
                )}
                {fieldVisible(draft.type, "cover") && (
                  <Field label="Muqova" hint="Rasm yuklang (JPEG, 9:16 tavsiya) yoki videodan kadr tanlang.">
                    <div className="flex flex-wrap items-center gap-2">
                      {draft.coverMediaId ? (
                        <Pill tone="success">Rasm tanlangan</Pill>
                      ) : (
                        <span className="text-xs text-muted">Kadr: {draft.thumbOffsetMs ? formatDuration(draft.thumbOffsetMs) : "boshi"}</span>
                      )}
                      <button type="button" className={secondaryButton} onClick={() => setPicker("cover")}>
                        Rasm tanlash
                      </button>
                      {draft.coverMediaId && (
                        <button type="button" className={secondaryButton} onClick={() => update({ coverMediaId: null })}>
                          Olib tashlash
                        </button>
                      )}
                    </div>
                    {!draft.coverMediaId && draft.media[0]?.durationMs ? (
                      <input type="range" min={0} max={draft.media[0].durationMs} step={100} value={draft.thumbOffsetMs ?? 0} onChange={(e) => update({ thumbOffsetMs: Number(e.target.value) })} aria-label="Muqova kadri (ms)" className="w-full" />
                    ) : null}
                  </Field>
                )}
                {fieldVisible(draft.type, "shareToFeed") && <Switch on={draft.shareToFeed} onChange={(shareToFeed) => update({ shareToFeed })} label="Feed'da ham ko'rsatish" hint="O'chirilsa Reels faqat Reels tabida chiqadi." />}
                {fieldVisible(draft.type, "trial") && (
                  <Field label="Trial Reels strategiyasi" hint="MANUAL — o'zingiz feed'ga chiqarasiz; SS_PERFORMANCE — yaxshi ishlasa Instagram o'zi chiqaradi.">
                    <select className={inputClass} value={draft.trialStrategy ?? "MANUAL"} onChange={(e) => update({ trialStrategy: e.target.value as PostDraft["trialStrategy"] })}>
                      <option value="MANUAL">MANUAL</option>
                      <option value="SS_PERFORMANCE">SS_PERFORMANCE</option>
                    </select>
                  </Field>
                )}
                {fieldVisible(draft.type, "aiFlag") && <Switch on={draft.isAiGenerated} onChange={(isAiGenerated) => update({ isAiGenerated })} label="AI yordamida yaratilgan" hint="Instagram postga 'AI' belgisini qo'yadi." />}
              </div>
            )}
          </section>

          {/* 5. Avtomatlashtirish */}
          <section className="space-y-3 rounded-2xl border border-border bg-surface p-4">
            <Switch
              on={Boolean(draft.linkCampaign)}
              onChange={(on) => update({ linkCampaign: on ? (campaigns[0] ? (campaigns[0].kind === "automation" ? { automationId: campaigns[0].id } : { triggerCampaignId: campaigns[0].id }) : {}) : null })}
              label="Shu postga comment-to-DM kampaniyasini ulash"
            />
            {draft.linkCampaign && (
              <>
                {campaigns.length === 0 ? (
                  <p className="text-xs text-muted">
                    Bu akkauntda bo&apos;sh kampaniya yo&apos;q —{" "}
                    <a className="underline" href="/developer/comments" target="_blank" rel="noreferrer">
                      Comment 2.0
                    </a>{" "}
                    da yarating, keyin shu yerda tanlang.
                  </p>
                ) : (
                  <select
                    className={inputClass}
                    value={linkedId}
                    onChange={(e) => {
                      const c = campaigns.find((x) => x.id === e.target.value);
                      update({ linkCampaign: c ? (c.kind === "automation" ? { automationId: c.id } : { triggerCampaignId: c.id }) : {} });
                    }}
                    aria-label="Kampaniya"
                  >
                    <option value="">Kampaniyani tanlang</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id} disabled={c.bound && c.active && c.linkedPostId !== postId}>
                        {c.name} · {c.keywords.join(", ") || "keyword yo'q"}
                        {c.bound ? (c.active ? " · boshqa postda ishlayapti" : " · boshqa postga bog'langan") : ""}
                      </option>
                    ))}
                  </select>
                )}
                {linked && <p className="text-xs text-muted">Post chiqishi bilan kampaniya shu postga faollashadi. Ungacha u &quot;post kutilmoqda&quot; holatida turadi va hech narsa yubormaydi.</p>}
                {issueFor("linkCampaign") && <p className="text-xs text-error">{issueFor("linkCampaign")}</p>}
              </>
            )}
          </section>

          {/* 6. Vaqt va rejim */}
          <section className="space-y-3 rounded-2xl border border-border bg-surface p-4">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Qachon">
              {(
                [
                  ["now", "Hozir"],
                  ["schedule", "Rejalashtirish"],
                  ["draft", "Draft"],
                ] as Array<[ComposerMode, string]>
              ).map(([m, label]) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={`${secondaryButton} ${mode === m ? "border-accent/60 text-foreground" : ""}`} disabled={m !== "draft" && !canSchedule}>
                  {label}
                </button>
              ))}
            </div>
            {mode === "schedule" && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Sana">
                  <input type="date" className={`${inputClass} !w-auto`} value={slot.date} min={utcToZoned(new Date(), tz).date} onChange={(e) => setSlot((s) => ({ ...s, date: e.target.value }))} />
                </Field>
                <Field label="Vaqt">
                  <input type="time" className={`${inputClass} !w-auto`} value={slot.time} step={300} onChange={(e) => setSlot((s) => ({ ...s, time: e.target.value }))} />
                </Field>
                <span className="pb-2 text-xs text-muted">{tz} · kamida 5 daqiqa keyin</span>
              </div>
            )}
            {issueFor("scheduledAt") && <p className="text-xs text-error">{issueFor("scheduledAt")}</p>}
            {canRecur && <RecurrenceFields value={recur} onChange={setRecur} startDate={slot.date} time={slot.time} timezone={tz} />}
            {!canSchedule && <p className="text-xs text-muted">Sizning rolingiz ({meta.me.roleLabel}) rejalashtira olmaydi — draft saqlanadi, MANAGER tasdiqlaydi.</p>}

            <div className="space-y-1 border-t border-border pt-3">
              <Switch
                on={draft.autoPublish}
                onChange={(on) => update({ autoPublish: canPublish ? on : false, manualReason: on && canPublish ? null : draft.type === "STORY" ? "STORY_STICKER" : "USER_CHOICE" })}
                label={draft.type === "STORY" ? "Avto-publish (stikersiz, linksiz story)" : "Avto-publish (Instagram API orqali)"}
              />
              {!draft.autoPublish && (
                <p className="text-xs text-muted">
                  {!canPublish
                    ? "Akkauntda publish ruxsati yo'q, shuning uchun qo'lda e'lon: vaqti kelganda media va caption Telegram'ga keladi."
                    : draft.type === "STORY"
                      ? "Qo'lda e'lon: vaqti kelganda media Telegram'ga keladi, stiker, link yoki musiqani Instagram ilovasida qo'shasiz."
                      : "Qo'lda e'lon: vaqti kelganda media va caption Telegram'ga keladi, siz o'zingiz chiqarasiz."}
                  {!meta.telegramConnected && (
                    <>
                      {" "}
                      Telegram ulanmagan —{" "}
                      <a className="underline" href="/developer/foundation" target="_blank" rel="noreferrer">
                        ulang
                      </a>
                      , aks holda email va dashboard orqali keladi.
                    </>
                  )}
                </p>
              )}
              {draft.type === "STORY" && draft.autoPublish && (
                <button type="button" className={`${secondaryButton} !py-1 text-xs`} onClick={() => update({ autoPublish: false, manualReason: "STORY_STICKER" })}>
                  Qo&apos;lda e&apos;lon (stiker, link yoki musiqa qo&apos;shaman)
                </button>
              )}
            </div>
          </section>

          {otherIssues.length > 0 && (
            <ul className="space-y-1 text-xs text-error">
              {otherIssues.map((i) => (
                <li key={`${i.field}-${i.message}`}>{i.message}</li>
              ))}
            </ul>
          )}

          <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 py-3 backdrop-blur">
            <button type="button" className={primaryButton} disabled={disabled} onClick={() => void save()}>
              {saving ? "Saqlanmoqda…" : buttonLabel}
            </button>
            {canSchedule && slotCount > 0 && !recurring && (
              <button type="button" className={secondaryButton} disabled={disabled} onClick={() => void save("queue")} title="Akkauntning keyingi bo'sh slotiga (kamida 5 daqiqa keyin)">
                Navbatga qo&apos;shish
              </button>
            )}
            {mode !== "draft" && (
              <button type="button" className={secondaryButton} disabled={saving || loading || locked || Boolean(blocked)} onClick={() => { setMode("draft"); void save("draft"); }}>
                Draft sifatida saqlash
              </button>
            )}
            {blocked && <span className="text-xs text-muted">{blocked}</span>}
            {!blocked && issues.length > 0 && <span className="text-xs text-error">{issues.length} ta xato bor</span>}
          </div>
        </fieldset>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <p className="mb-2 text-center text-[11px] text-muted">Jonli preview</p>
          <Preview draft={draft} username={account?.username ?? ""} />
        </aside>
      </div>

      {picker === "media" && (
        <MediaPicker
          kinds={rules.kinds}
          onPick={(rows) => {
            addMedia(rows.map(rowToItem));
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === "cover" && (
        <MediaPicker
          kinds={["IMAGE"]}
          onPick={(rows) => {
            if (rows[0]) update({ coverMediaId: rows[0].id, thumbOffsetMs: null });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/** A switch with its text beside it (the text is not a hit area, like comment-builder). */
function Switch({ on, onChange, label, hint }: { on: boolean; onChange: (on: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm text-foreground">
        {label}
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <Toggle on={on} onChange={onChange} label={label} />
    </div>
  );
}

function Counter({ value, max, label }: { value: number; max: number; label: string }) {
  const over = value > max;
  return (
    <span className={over ? "font-semibold text-error" : value > max * 0.9 ? "text-warning" : "text-muted"}>
      {value}/{max} {label}
    </span>
  );
}
