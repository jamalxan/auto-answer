"use client";

/**
 * Kutubxona (spec §10.5): grid of uploaded assets with processing state,
 * tags, usage and the storage quota bar; the upload drop zone; and the
 * picker the composer opens to choose existing files. Uploads go through
 * the bounded queue in upload-queue.ts, so dropping dozens of files keeps
 * the page responsive.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { CONTENT_API, formatBytes, formatDuration, jsonInit, requestJson, type ContentMeta, type MediaRow } from "./shared";
import { inputClass, Pill, primaryButton, secondaryButton } from "./ui";
import { ACCEPT, useUploadQueue, type ReadyAsset, type UploadItem } from "./upload-queue";
import { TypeGlyph } from "./type-glyph";

export type { ReadyAsset } from "./upload-queue";

export function useLibrary(kind?: "IMAGE" | "VIDEO") {
  const [items, setItems] = useState<MediaRow[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const params = new URLSearchParams({ pageSize: "200" });
    if (kind) params.set("kind", kind);
    const res = await requestJson<{ items: MediaRow[] }>(`${CONTENT_API}/media?${params.toString()}`);
    if (mine !== seq.current) return;
    setLoaded(true);
    if (res.ok) {
      setItems(res.data.items);
      setFailure(null);
    } else setFailure(res.error);
  }, [kind]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch
    void load();
  }, [load]);
  return { items, failure, loaded, reload: load };
}

const PHASE_LABEL: Record<UploadItem["phase"], string> = {
  queued: "Navbatda",
  upload: "Yuklanmoqda",
  process: "Instagram uchun tayyorlanmoqda…",
  done: "Tayyor",
  error: "Xato",
  canceled: "Bekor qilindi",
};

/**
 * Drop zone + file input + the live list of the queue. `onUploaded` gets
 * the ready assets in the order they were picked (a carousel keeps it).
 */
export function UploadZone({ onUploaded, max = 30, compact = false }: { onUploaded: (assets: ReadyAsset[]) => void; max?: number; compact?: boolean }) {
  const { items, summary, add, cancel, retry, clear } = useUploadQueue(onUploaded);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function handle(files: FileList | File[]) {
    const list = Array.from(files);
    const room = Math.max(0, max - items.filter((i) => i.phase === "queued" || i.phase === "upload" || i.phase === "process").length);
    setNote(list.length > room ? `Bir vaqtda ${max} tagacha fayl — ${room} tasi olindi, qolganini keyin tashlang.` : null);
    if (room > 0) add(list.slice(0, room));
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) handle(e.dataTransfer.files);
  }

  const finished = items.filter((i) => i.phase === "done" || i.phase === "canceled").length;

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!over) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-3xl text-center transition-colors ${
          over ? "bg-violet/20 ring-2 ring-inset ring-violet" : "bg-midnight hover:bg-surface-hover"
        } ${compact ? "px-4 py-5" : "px-6 py-10"}`}
      >
        <span className={`grid place-items-center rounded-full bg-violet/20 text-white ${compact ? "h-9 w-9" : "h-12 w-12"}`} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
        </span>
        <span className="mt-1 text-[15px] font-semibold text-white">{over ? "Qo'yib yuboring" : "Fayllarni shu yerga tashlang yoki bosib tanlang"}</span>
        <span className="text-xs text-muted">
          Rasm: JPEG, PNG, WEBP (30 MB gacha) · Video: MP4, MOV (1 GB gacha) · bir vaqtda {max} tagacha
        </span>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handle(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {note && <Notice tone="warning">{note}</Notice>}

      {items.length > 0 && (
        <div className="inset space-y-3 p-3 sm:p-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="font-semibold text-white">{summary.total} ta fayl</span>
            <span className="text-muted">
              {[
                summary.done && `${summary.done} tayyor`,
                summary.uploading && `${summary.uploading} yuklanmoqda`,
                summary.processing && `${summary.processing} tayyorlanmoqda`,
                summary.queued && `${summary.queued} navbatda`,
                summary.failed && `${summary.failed} xato`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {finished > 0 && (
              <button type="button" className="ml-auto text-xs font-semibold text-muted hover:text-white" onClick={() => clear()}>
                Tayyorlarni tozalash
              </button>
            )}
          </div>
          {summary.active && (
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-valuenow={summary.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Umumiy yuklash">
              <div className="h-full rounded-full bg-violet transition-[width] duration-300" style={{ width: `${summary.pct}%` }} />
            </div>
          )}
          <ul className={compact ? "space-y-1.5" : "grid gap-2 sm:grid-cols-2 lg:grid-cols-3"}>
            {items.map((item) => (
              <UploadRow key={item.key} item={item} onCancel={() => cancel(item.key)} onRetry={() => retry(item.key)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UploadRow({ item, onCancel, onRetry }: { item: UploadItem; onCancel: () => void; onRetry: () => void }) {
  const preview = item.asset?.thumbUrl ?? item.localUrl;
  const busy = item.phase === "queued" || item.phase === "upload" || item.phase === "process";
  return (
    <li className="flex items-center gap-3 rounded-2xl bg-surface p-2">
      <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-midnight">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL or signed thumb
          <img src={preview} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted">
            <TypeGlyph group={item.kind === "VIDEO" ? "reels" : "post"} width={18} height={18} />
          </span>
        )}
        {item.phase === "process" && <span className="absolute inset-0 animate-pulse bg-midnight/50" aria-hidden="true" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-white">{item.name}</span>
        <span className={`block truncate text-xs ${item.phase === "error" ? "text-error" : item.phase === "done" ? "text-lime" : "text-muted"}`}>
          {item.phase === "upload" ? `${item.pct}% · ${formatBytes(item.size)}` : item.phase === "error" ? item.error : `${PHASE_LABEL[item.phase]}${item.phase === "queued" ? ` · ${formatBytes(item.size)}` : ""}`}
        </span>
        {item.phase === "upload" && (
          <span className="mt-1 block h-1 overflow-hidden rounded-full bg-white/[0.08]">
            <span className="block h-full rounded-full bg-violet" style={{ width: `${item.pct}%` }} />
          </span>
        )}
      </span>
      {busy && (
        <button type="button" className="rounded-full px-2 py-1 text-xs font-semibold text-muted hover:bg-white/[0.08] hover:text-white" onClick={onCancel} aria-label={`${item.name} — bekor qilish`}>
          Bekor
        </button>
      )}
      {item.phase === "error" && (
        <button type="button" className="rounded-full px-2 py-1 text-xs font-semibold text-violet hover:bg-white/[0.08] hover:text-white" onClick={onRetry}>
          Qayta
        </button>
      )}
    </li>
  );
}

function StatusPill({ row }: { row: MediaRow }) {
  if (row.status === "READY") return null;
  if (row.status === "FAILED") return <Pill tone="error">Xato</Pill>;
  return <Pill tone="warning">{row.status === "UPLOADING" ? "Yuklanmoqda" : "Tayyorlanmoqda"}</Pill>;
}

export default function MediaLibrary({ meta }: { meta: ContentMeta }) {
  const [kind, setKind] = useState<"" | "IMAGE" | "VIDEO">("");
  const { items, failure, loaded, reload } = useLibrary(kind || undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});
  const used = meta.storage.usedBytes;
  const pct = Math.min(100, Math.round((used / Math.max(1, meta.storage.quotaBytes)) * 100));

  // Rows still being prepared refresh on their own (slowly), so the grid never looks stuck.
  const pending = items.some((i) => i.status === "PROCESSING" || i.status === "UPLOADING");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void reload(), 6000);
    return () => clearInterval(t);
  }, [pending, reload]);

  // Many files finishing at once → one reload, not one per file.
  const reloadSoon = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUploaded = useCallback(() => {
    if (reloadSoon.current) clearTimeout(reloadSoon.current);
    reloadSoon.current = setTimeout(() => void reload(), 400);
  }, [reload]);

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    const res = await requestJson(`${CONTENT_API}/media/${id}`, { method: "DELETE" });
    setBusy(null);
    if (!res.ok) setError(res.error);
    else void reload();
  }

  async function saveTags(id: string) {
    const tags = (tagDraft[id] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const res = await requestJson(`${CONTENT_API}/media/${id}`, jsonInit("PATCH", { tags }));
    if (!res.ok) setError(res.error);
    else void reload();
  }

  return (
    <div className="space-y-4">
      <section className="panel rounded-3xl p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-base font-bold text-white">Fayl yuklash</h3>
            <p className="mt-1 text-sm text-muted">Fayllar navbat bilan yuklanadi va Instagram talablariga moslab tayyorlanadi — sahifadan chiqmang.</p>
          </div>
          <div className="min-w-[200px] text-right">
            <p className="text-xs text-muted">
              Ombor: <span className="font-semibold text-white">{formatBytes(used)}</span> / {formatBytes(meta.storage.quotaBytes)}
            </p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
              <div className={`h-full rounded-full ${pct >= 90 ? "bg-error" : pct >= 70 ? "bg-warning" : "bg-lime"}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
        {meta.me.canCreate ? <UploadZone max={50} onUploaded={onUploaded} /> : <p className="text-sm text-muted">Sizning rolingizda fayl yuklab bo&apos;lmaydi.</p>}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["", "Hammasi"],
            ["IMAGE", "Rasmlar"],
            ["VIDEO", "Videolar"],
          ] as const
        ).map(([value, label]) => (
          <button key={value || "all"} type="button" className={`chip ${kind === value ? "chip-active" : ""}`} aria-pressed={kind === value} onClick={() => setKind(value)}>
            {label}
          </button>
        ))}
        <span className="ml-auto text-sm text-muted">{items.length} ta fayl</span>
      </div>
      {failure && <Notice tone="error">{failure}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {!loaded ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-hidden="true">
          {Array.from({ length: 10 }, (_, i) => (
            <li key={i} className="panel aspect-[4/5] animate-pulse rounded-3xl" />
          ))}
        </ul>
      ) : items.length === 0 ? (
        <div className="panel rounded-3xl px-6 py-12 text-center">
          <p className="text-base font-bold text-white">Kutubxona bo&apos;sh</p>
          <p className="mt-1 text-sm text-muted">Yuqoridagi maydonga rasm yoki video tashlang.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {items.map((row) => (
            <li key={row.id} className="panel flex flex-col gap-2 rounded-3xl p-2">
              <div className="relative aspect-square overflow-hidden rounded-2xl bg-midnight">
                {row.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                  <img src={row.thumbUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted">
                    <TypeGlyph group={row.kind === "VIDEO" ? "reels" : "post"} width={22} height={22} />
                  </div>
                )}
                <span className="absolute left-1.5 top-1.5">
                  <StatusPill row={row} />
                </span>
                {row.kind === "VIDEO" && row.durationMs ? (
                  <span className="absolute bottom-1.5 right-1.5 rounded-full bg-midnight/80 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">{formatDuration(row.durationMs)}</span>
                ) : null}
              </div>
              <div className="px-1 text-[11px] text-muted">
                {row.width && row.height ? `${row.width}×${row.height} · ` : ""}
                {formatBytes(row.sizeBytes)}
                {row.usedByPostIds.length > 0 && ` · ${row.usedByPostIds.length} ta postda`}
              </div>
              {row.error && <p className="px-1 text-[11px] text-error">{row.error}</p>}
              <input
                className={`${inputClass} !px-3 !py-1.5 text-xs`}
                placeholder="teglar, vergul bilan"
                value={tagDraft[row.id] ?? row.tags.join(", ")}
                onChange={(e) => setTagDraft((d) => ({ ...d, [row.id]: e.target.value }))}
                onBlur={() => tagDraft[row.id] !== undefined && void saveTags(row.id)}
              />
              {meta.me.canSchedule && (
                <button type="button" className={`${secondaryButton} !py-1.5 text-xs`} disabled={busy === row.id || row.usedByPostIds.length > 0} onClick={() => void remove(row.id)} title={row.usedByPostIds.length > 0 ? "Postda ishlatilmoqda" : undefined}>
                  O&apos;chirish
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The composer's "kutubxonadan tanlash" dialog. */
export function MediaPicker({ kinds, onPick, onClose }: { kinds: Array<"IMAGE" | "VIDEO">; onPick: (rows: MediaRow[]) => void; onClose: () => void }) {
  const { items, failure, loaded } = useLibrary(kinds.length === 1 ? kinds[0] : undefined);
  const [chosen, setChosen] = useState<string[]>([]);
  const ready = items.filter((i) => i.status === "READY" && kinds.includes(i.kind as "IMAGE" | "VIDEO"));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-midnight/80 p-3 backdrop-blur-sm sm:items-center" role="dialog" aria-modal="true" aria-label="Kutubxonadan tanlash" onClick={onClose}>
      <div className="panel max-h-[85vh] w-full max-w-3xl overflow-auto rounded-3xl p-5 shadow-float" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-white">Kutubxonadan tanlash</h3>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Yopish
          </button>
        </div>
        {failure && <Notice tone="error">{failure}</Notice>}
        {!loaded ? (
          <p className="text-sm text-muted">Yuklanmoqda…</p>
        ) : ready.length === 0 ? (
          <p className="text-sm text-muted">Tayyor fayl yo&apos;q — avval yuklang.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {ready.map((row) => {
              const on = chosen.includes(row.id);
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setChosen((c) => (on ? c.filter((x) => x !== row.id) : [...c, row.id]))}
                    className={`relative aspect-square w-full overflow-hidden rounded-2xl bg-midnight ${on ? "ring-2 ring-lime ring-offset-2 ring-offset-surface" : ""}`}
                    aria-pressed={on}
                  >
                    {row.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                      <img src={row.thumbUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full items-center justify-center text-muted">
                        <TypeGlyph group={row.kind === "VIDEO" ? "reels" : "post"} width={20} height={20} />
                      </span>
                    )}
                    {row.kind === "VIDEO" && row.durationMs ? (
                      <span className="absolute bottom-1 left-1 rounded-full bg-midnight/80 px-1.5 text-[10px] font-semibold tabular-nums text-white">{formatDuration(row.durationMs)}</span>
                    ) : null}
                    {on && <span className="absolute right-1 top-1 grid h-5 min-w-5 place-items-center rounded-full bg-lime px-1 text-[11px] font-bold text-midnight">{chosen.indexOf(row.id) + 1}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <button type="button" className={primaryButton} disabled={chosen.length === 0} onClick={() => onPick(chosen.map((id) => ready.find((r) => r.id === id)!).filter(Boolean))}>
            Tanlash ({chosen.length})
          </button>
        </div>
      </div>
    </div>
  );
}

