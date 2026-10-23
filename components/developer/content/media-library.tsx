"use client";

/**
 * Kutubxona (spec §10.5): grid of uploaded assets with processing state,
 * tags, usage and the storage quota bar; the upload drop zone; and the
 * picker the composer opens to choose existing files.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { CONTENT_API, formatBytes, formatDuration, jsonInit, requestJson, uploadFile, type ContentMeta, type MediaRow } from "./shared";

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime";

interface UploadState {
  name: string;
  pct: number;
  phase: "upload" | "process" | "done" | "error";
  error?: string;
}

export function useLibrary(kind?: "IMAGE" | "VIDEO") {
  const [items, setItems] = useState<MediaRow[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const params = new URLSearchParams({ pageSize: "200" });
    if (kind) params.set("kind", kind);
    const res = await requestJson<{ items: MediaRow[] }>(`${CONTENT_API}/media?${params.toString()}`);
    if (mine !== seq.current) return;
    if (res.ok) {
      setItems(res.data.items);
      setFailure(null);
    } else setFailure(res.error);
  }, [kind]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch
    void load();
  }, [load]);
  return { items, failure, reload: load };
}

/** Drop zone + file input; calls onUploaded for every READY asset. */
export function UploadZone({ onUploaded, max = 20, compact = false }: { onUploaded: (asset: Awaited<ReturnType<typeof uploadFile>>) => void; max?: number; compact?: boolean }) {
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const input = useRef<HTMLInputElement>(null);

  async function handle(files: FileList | File[]) {
    const list = Array.from(files).slice(0, max);
    for (const file of list) {
      const key = `${file.name}-${file.size}`;
      setUploads((u) => [...u.filter((x) => x.name !== key), { name: key, pct: 0, phase: "upload" }]);
      try {
        const asset = await uploadFile(file, (pct) => setUploads((u) => u.map((x) => (x.name === key ? { ...x, pct, phase: pct >= 100 ? "process" : "upload" } : x))));
        setUploads((u) => u.map((x) => (x.name === key ? { ...x, phase: "done", pct: 100 } : x)));
        onUploaded(asset);
      } catch (error) {
        setUploads((u) => u.map((x) => (x.name === key ? { ...x, phase: "error", error: error instanceof Error ? error.message : "Xato" } : x)));
      }
    }
    setTimeout(() => setUploads((u) => u.filter((x) => x.phase === "error")), 4000);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.files.length) void handle(e.dataTransfer.files);
  }

  return (
    <div>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && input.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border-hover bg-surface text-center text-sm text-muted hover:border-accent/50 ${compact ? "px-3 py-3" : "px-4 py-8"}`}
      >
        <span className="font-semibold text-foreground">Fayl tashlang yoki bosib tanlang</span>
        <span className="mt-1 text-xs">JPEG, PNG, WEBP, HEIC (30 MB gacha) · MP4, MOV (1 GB gacha) · bir vaqtda {max} tagacha</span>
        <input ref={input} type="file" accept={ACCEPT} multiple className="hidden" onChange={(e) => e.target.files && void handle(e.target.files)} />
      </div>
      {uploads.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {uploads.map((u) => (
            <li key={u.name} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{u.name.replace(/-\d+$/, "")}</span>
              {u.phase === "upload" && <span className="text-muted">{u.pct}%</span>}
              {u.phase === "process" && <span className="text-muted">Instagram uchun tayyorlanmoqda…</span>}
              {u.phase === "done" && <span className="text-success">tayyor</span>}
              {u.phase === "error" && <span className="text-error">{u.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusPill({ row }: { row: MediaRow }) {
  if (row.status === "READY") return <Pill tone="success">Tayyor</Pill>;
  if (row.status === "FAILED") return <Pill tone="error">Xato</Pill>;
  return <Pill tone="warning">{row.status === "UPLOADING" ? "Yuklanmoqda" : "Qayta ishlanmoqda"}</Pill>;
}

export default function MediaLibrary({ meta }: { meta: ContentMeta }) {
  const [kind, setKind] = useState<"" | "IMAGE" | "VIDEO">("");
  const { items, failure, reload } = useLibrary(kind || undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState<Record<string, string>>({});
  const used = meta.storage.usedBytes;
  const pct = Math.min(100, Math.round((used / Math.max(1, meta.storage.quotaBytes)) * 100));

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
      <div className="rounded-2xl border border-border bg-surface p-4">
        <div className="mb-2 flex items-center justify-between text-xs text-muted">
          <span>
            Ombor: {formatBytes(used)} / {formatBytes(meta.storage.quotaBytes)} · {meta.storage.driver}
          </span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-border">
          <div className={`h-full ${pct >= 90 ? "bg-error" : pct >= 70 ? "bg-warning" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {meta.me.canCreate && <UploadZone onUploaded={() => void reload()} />}

      <div className="flex items-center gap-2">
        <select className={`${inputClass} !w-auto`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Tur">
          <option value="">Rasm va video</option>
          <option value="IMAGE">Faqat rasm</option>
          <option value="VIDEO">Faqat video</option>
        </select>
        <button type="button" className={secondaryButton} onClick={() => void reload()}>
          Yangilash
        </button>
      </div>
      {failure && <Notice tone="error">{failure}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {items.length === 0 ? (
        <p className="text-sm text-muted">Kutubxona bo&apos;sh.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-2">
              <div className="relative aspect-square overflow-hidden rounded-lg bg-background">
                {row.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                  <img src={row.thumbUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted">{row.kind === "VIDEO" ? "▶" : "▣"}</div>
                )}
                <span className="absolute left-1 top-1">
                  <StatusPill row={row} />
                </span>
                {row.kind === "VIDEO" && row.durationMs ? <span className="absolute bottom-1 right-1 rounded bg-background/80 px-1 text-[10px]">{formatDuration(row.durationMs)}</span> : null}
              </div>
              <div className="text-[11px] text-muted">
                {row.width && row.height ? `${row.width}×${row.height} · ` : ""}
                {formatBytes(row.sizeBytes)}
                {row.usedByPostIds.length > 0 && ` · ${row.usedByPostIds.length} ta postda`}
              </div>
              {row.error && <p className="text-[11px] text-error">{row.error}</p>}
              <input
                className={`${inputClass} !py-1 text-xs`}
                placeholder="teglar, vergul bilan"
                value={tagDraft[row.id] ?? row.tags.join(", ")}
                onChange={(e) => setTagDraft((d) => ({ ...d, [row.id]: e.target.value }))}
                onBlur={() => tagDraft[row.id] !== undefined && void saveTags(row.id)}
              />
              {meta.me.canSchedule && (
                <button type="button" className={`${secondaryButton} !py-1 text-xs`} disabled={busy === row.id || row.usedByPostIds.length > 0} onClick={() => void remove(row.id)}>
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
  const { items, failure } = useLibrary(kinds.length === 1 ? kinds[0] : undefined);
  const [chosen, setChosen] = useState<string[]>([]);
  const ready = items.filter((i) => i.status === "READY" && kinds.includes(i.kind as "IMAGE" | "VIDEO"));
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-background/80 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label="Kutubxonadan tanlash">
      <div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-2xl border border-border bg-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Kutubxonadan tanlash</h3>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Yopish
          </button>
        </div>
        {failure && <Notice tone="error">{failure}</Notice>}
        {ready.length === 0 ? (
          <p className="text-sm text-muted">Tayyor fayl yo&apos;q — avval yuklang.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {ready.map((row) => {
              const on = chosen.includes(row.id);
              return (
                <li key={row.id}>
                  <button type="button" onClick={() => setChosen((c) => (on ? c.filter((x) => x !== row.id) : [...c, row.id]))} className={`relative aspect-square w-full overflow-hidden rounded-lg border-2 ${on ? "border-accent" : "border-transparent"}`} aria-pressed={on}>
                    {row.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                      <img src={row.thumbUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full items-center justify-center bg-background text-muted">{row.kind === "VIDEO" ? "▶" : "▣"}</span>
                    )}
                    {on && <span className="absolute right-1 top-1 rounded-full bg-accent px-1.5 text-[10px] font-bold text-background">{chosen.indexOf(row.id) + 1}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3 flex justify-end">
          <button type="button" className={primaryButton} disabled={chosen.length === 0} onClick={() => onPick(chosen.map((id) => ready.find((r) => r.id === id)!).filter(Boolean))}>
            Tanlash ({chosen.length})
          </button>
        </div>
      </div>
    </div>
  );
}
