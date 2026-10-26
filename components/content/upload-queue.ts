"use client";

/**
 * The planner's upload queue. Dropping 30 Reels and photos at once must not
 * freeze the tab or flood the server, so:
 *
 *   - at most PUT_CONCURRENCY files go up at the same time, the rest wait;
 *   - every mutation lands in a ref and the screen repaints at most once per
 *     animation frame (an XHR fires hundreds of progress events per file);
 *   - every file still being prepared is polled in ONE request
 *     (/media/status?ids=…), every 2 s at first and slower later — instead of
 *     each file re-reading the whole library;
 *   - a photo gets a 120 px local preview, decoded off the main thread
 *     (createImageBitmap with resize) one file at a time — 24 full-size 12 MP
 *     object URLs decoded at once froze the tab for seconds;
 *   - a file can be cancelled (its quota reservation is released) or retried;
 *   - ready files are handed over in the order they were picked, so a
 *     carousel keeps the user's order however the uploads finish.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CONTENT_API, jsonInit, requestJson } from "./shared";

export const ACCEPT = "image/jpeg,image/png,image/webp,video/mp4,video/quicktime";
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime"];
const IMAGE_MAX = 30 * 1024 ** 2;
const VIDEO_MAX = 1024 ** 3;

export const PUT_CONCURRENCY = 3;
const POLL_FAST_MS = 2000;
const POLL_SLOW_MS = 5000;
const POLL_FAST_FOR_MS = 60_000;
/** Give up polling one file after this long (the video queue can be long, but not endless). */
const PROCESS_GIVE_UP_MS = 90 * 60_000;
const STATUS_BATCH = 50;

export type UploadPhase = "queued" | "upload" | "process" | "done" | "error" | "canceled";

export interface ReadyAsset {
  id: string;
  kind: string;
  status: string;
  thumbUrl: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface UploadItem {
  key: string;
  batch: number;
  index: number;
  name: string;
  size: number;
  kind: "IMAGE" | "VIDEO";
  /** Object URL of a small local preview of a picked photo, before the server has a thumbnail. */
  localUrl: string | null;
  pct: number;
  phase: UploadPhase;
  error: string | null;
  mediaId: string | null;
  asset: ReadyAsset | null;
  processSince: number | null;
}

/** Why a file is refused before anything is sent, or null. Mirrors lib/content/media.ts. */
export function precheckFile(file: { name: string; type: string; size: number }): string | null {
  const type = file.type.toLowerCase();
  if (/hei[cf]$/.test(type) || /\.(heic|heif)$/i.test(file.name)) return "HEIC hozircha qabul qilinmaydi — JPEG'ga o'giring";
  if (!IMAGE_TYPES.includes(type) && !VIDEO_TYPES.includes(type)) return "Bu fayl turi qabul qilinmaydi (JPEG, PNG, WEBP, MP4, MOV)";
  if (file.size <= 0) return "Fayl bo'sh";
  if (IMAGE_TYPES.includes(type) && file.size > IMAGE_MAX) return "Rasm 30 MB dan katta";
  if (VIDEO_TYPES.includes(type) && file.size > VIDEO_MAX) return "Video 1 GB dan katta";
  return null;
}

const TERMINAL: UploadPhase[] = ["done", "error", "canceled"];

/**
 * Which finished items may be handed over now: per batch, in pick order, up
 * to the first item still on its way. Failed and cancelled items do not
 * hold the line. Pure, for the tests.
 */
export function releasable(items: Array<Pick<UploadItem, "key" | "batch" | "index" | "phase">>, released: ReadonlySet<string>): string[] {
  const batches = new Map<number, typeof items>();
  for (const item of items) batches.set(item.batch, [...(batches.get(item.batch) ?? []), item]);
  const out: string[] = [];
  for (const list of batches.values()) {
    for (const item of [...list].sort((a, b) => a.index - b.index)) {
      if (!TERMINAL.includes(item.phase)) break;
      if (item.phase === "done" && !released.has(item.key)) out.push(item.key);
    }
  }
  return out;
}

/** "12 ta fayl · 5 tayyor · 3 yuklanmoqda · 4 navbatda" and the overall percent. */
export function queueSummary(items: Array<Pick<UploadItem, "phase" | "pct" | "size">>) {
  const count = (phase: UploadPhase) => items.filter((i) => i.phase === phase).length;
  const live = items.filter((i) => i.phase !== "canceled");
  const total = live.reduce((sum, i) => sum + i.size, 0);
  const sent = live.reduce((sum, i) => sum + (i.phase === "queued" || i.phase === "error" ? 0 : i.phase === "upload" ? (i.size * i.pct) / 100 : i.size), 0);
  return {
    total: live.length,
    queued: count("queued"),
    uploading: count("upload"),
    processing: count("process"),
    done: count("done"),
    failed: count("error"),
    pct: total > 0 ? Math.round((sent / total) * 100) : 0,
    active: count("queued") + count("upload") + count("process") > 0,
  };
}

export function useUploadQueue(onReady: (assets: ReadyAsset[]) => void) {
  const items = useRef(new Map<string, UploadItem>());
  const files = useRef(new Map<string, File>());
  const xhrs = useRef(new Map<string, XMLHttpRequest>());
  const released = useRef(new Set<string>());
  const batchSeq = useRef(0);
  const keySeq = useRef(0);
  const frame = useRef<number | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while a poll request is in flight: one poll loop at a time, however many uploads finish.
  const polling = useRef(false);
  const alive = useRef(true);
  const onReadyRef = useRef(onReady);
  const [snapshot, setSnapshot] = useState<UploadItem[]>([]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const flush = useCallback(() => {
    if (frame.current !== null || !alive.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (alive.current) setSnapshot([...items.current.values()]);
    });
  }, []);

  const patch = useCallback(
    (key: string, next: Partial<UploadItem>) => {
      const item = items.current.get(key);
      if (!item) return;
      items.current.set(key, { ...item, ...next });
      flush();
    },
    [flush]
  );

  const release = useCallback(() => {
    const keys = releasable([...items.current.values()], released.current);
    if (keys.length === 0) return;
    for (const key of keys) released.current.add(key);
    const assets = keys.map((key) => items.current.get(key)?.asset).filter((a): a is ReadyAsset => Boolean(a));
    if (assets.length) onReadyRef.current(assets);
  }, []);

  // ── processing poll: one request for every file still being prepared ──────
  const pollRef = useRef<() => Promise<void>>(async () => undefined);
  const pollOnce = useCallback(async () => {
    const waiting = [...items.current.values()].filter((i) => i.phase === "process" && i.mediaId);
    if (waiting.length === 0) return;
    const now = Date.now();
    for (let i = 0; i < waiting.length; i += STATUS_BATCH) {
      const chunk = waiting.slice(i, i + STATUS_BATCH);
      const res = await requestJson<{ items: Array<ReadyAsset & { error: string | null }> }>(`${CONTENT_API}/media/status?ids=${chunk.map((c) => c.mediaId).join(",")}`);
      if (!res.ok || !alive.current) continue;
      const byId = new Map(res.data.items.map((row) => [row.id, row]));
      for (const item of chunk) {
        const current = items.current.get(item.key);
        if (!current || current.phase !== "process") continue;
        const row = byId.get(item.mediaId!);
        if (row?.status === "READY") {
          patch(item.key, { phase: "done", pct: 100, asset: { id: row.id, kind: row.kind, status: row.status, thumbUrl: row.thumbUrl, width: row.width, height: row.height, durationMs: row.durationMs } });
        } else if (row?.status === "FAILED" || row?.status === "DELETED" || !row) {
          patch(item.key, { phase: "error", error: row?.error ?? "Fayl qayta ishlanmadi" });
        } else if (current.processSince && now - current.processSince > PROCESS_GIVE_UP_MS) {
          patch(item.key, { phase: "error", error: "Tayyorlash juda uzoq davom etdi — keyinroq Kutubxonadan tanlang" });
        }
      }
    }
    release();
  }, [patch, release]);

  const poll = useCallback(async () => {
    pollTimer.current = null;
    if (!alive.current || polling.current) return;
    polling.current = true;
    try {
      await pollOnce();
    } finally {
      polling.current = false;
    }
    const still = [...items.current.values()].filter((i) => i.phase === "process");
    if (still.length && alive.current && pollTimer.current === null) {
      const now = Date.now();
      const oldest = Math.min(...still.map((i) => i.processSince ?? now));
      pollTimer.current = setTimeout(() => void pollRef.current(), now - oldest < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS);
    }
  }, [pollOnce]);

  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  const ensurePolling = useCallback(() => {
    if (pollTimer.current === null && !polling.current) pollTimer.current = setTimeout(() => void pollRef.current(), POLL_FAST_MS);
  }, []);

  // ── upload of one file: presign → PUT → complete ───────────────────────────
  const pumpRef = useRef<() => void>(() => undefined);

  const start = useCallback(
    async (key: string) => {
      const file = files.current.get(key);
      if (!file) return;
      patch(key, { phase: "upload", pct: 0, error: null });
      try {
        const presign = await requestJson<{ mediaId: string; uploadUrl: string; headers: Record<string, string> }>(
          `${CONTENT_API}/media/presign`,
          jsonInit("POST", { fileName: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size })
        );
        if (!presign.ok) throw new Error(presign.error);
        if (items.current.get(key)?.phase === "canceled") {
          void requestJson(`${CONTENT_API}/media/${presign.data.mediaId}`, { method: "DELETE" });
          return;
        }
        patch(key, { mediaId: presign.data.mediaId });
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhrs.current.set(key, xhr);
          xhr.open("PUT", presign.data.uploadUrl);
          for (const [k, v] of Object.entries(presign.data.headers)) {
            if (k.toLowerCase() === "content-length") continue;
            xhr.setRequestHeader(k, v);
          }
          let lastPct = -1;
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const pct = Math.min(99, Math.floor((e.loaded / e.total) * 100));
            if (pct !== lastPct) {
              lastPct = pct;
              patch(key, { pct });
            }
          };
          xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 413 ? "Fayl server chegarasidan katta" : `Yuklash xatosi (${xhr.status})`)));
          xhr.onerror = () => reject(new Error("Yuklash uzildi — internetni tekshiring"));
          xhr.onabort = () => reject(new Error("CANCELED"));
          xhr.send(file);
        }).finally(() => xhrs.current.delete(key));
        const complete = await requestJson<{ id: string; status: string }>(`${CONTENT_API}/media/${presign.data.mediaId}/complete`, jsonInit("POST", {}));
        if (!complete.ok) throw new Error(complete.error);
        patch(key, { phase: "process", pct: 100, processSince: Date.now() });
        ensurePolling();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Xato";
        if (message !== "CANCELED" && items.current.get(key)?.phase !== "canceled") patch(key, { phase: "error", error: message });
        release();
      } finally {
        pumpRef.current();
      }
    },
    [ensurePolling, patch, release]
  );

  const pump = useCallback(() => {
    if (!alive.current) return;
    const list = [...items.current.values()];
    let running = list.filter((i) => i.phase === "upload").length;
    for (const item of list.sort((a, b) => a.batch - b.batch || a.index - b.index)) {
      if (running >= PUT_CONCURRENCY) break;
      if (item.phase !== "queued") continue;
      running++;
      void start(item.key);
    }
  }, [start]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  // ── small local previews, one at a time, decoded off the main thread ─────
  const previewQueue = useRef<string[]>([]);
  const previewing = useRef(false);
  const makePreviews = useCallback(async () => {
    if (previewing.current || typeof createImageBitmap !== "function") return;
    previewing.current = true;
    try {
      for (let key = previewQueue.current.shift(); key && alive.current; key = previewQueue.current.shift()) {
        const file = files.current.get(key);
        const item = items.current.get(key);
        if (!file || !item || item.asset || item.phase === "canceled") continue;
        try {
          const bitmap = await createImageBitmap(file, { resizeWidth: 120, resizeQuality: "low" });
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));
          if (blob && items.current.has(key)) patch(key, { localUrl: URL.createObjectURL(blob) });
        } catch {
          // No preview (unsupported decode) — the row shows the type icon until the server thumb arrives.
        }
      }
    } finally {
      previewing.current = false;
    }
  }, [patch]);

  const add = useCallback(
    (picked: File[]) => {
      const batch = ++batchSeq.current;
      picked.forEach((file, index) => {
        const key = `u${++keySeq.current}`;
        const refused = precheckFile(file);
        const kind = file.type.startsWith("video/") ? "VIDEO" : "IMAGE";
        files.current.set(key, file);
        items.current.set(key, {
          key,
          batch,
          index,
          name: file.name,
          size: file.size,
          kind,
          localUrl: null,
          pct: 0,
          phase: refused ? "error" : "queued",
          error: refused,
          mediaId: null,
          asset: null,
          processSince: null,
        });
      });
      flush();
      pump();
      for (const [key, item] of items.current) if (item.batch === batch && item.kind === "IMAGE" && item.phase !== "error") previewQueue.current.push(key);
      void makePreviews();
    },
    [flush, pump, makePreviews]
  );

  const cancel = useCallback(
    (key: string) => {
      const item = items.current.get(key);
      if (!item || TERMINAL.includes(item.phase)) return;
      patch(key, { phase: "canceled" });
      xhrs.current.get(key)?.abort();
      // The row holds a quota reservation; deleting it releases the bytes.
      if (item.mediaId) void requestJson(`${CONTENT_API}/media/${item.mediaId}`, { method: "DELETE" });
      release();
      pump();
    },
    [patch, pump, release]
  );

  const retry = useCallback(
    (key: string) => {
      const item = items.current.get(key);
      const file = files.current.get(key);
      if (!item || item.phase !== "error" || !file || precheckFile(file)) return;
      // A failed row still reserves its bytes until it is deleted.
      if (item.mediaId) void requestJson(`${CONTENT_API}/media/${item.mediaId}`, { method: "DELETE" });
      patch(key, { phase: "queued", pct: 0, error: null, mediaId: null, processSince: null });
      pump();
    },
    [patch, pump]
  );

  /** Drop finished rows from the list (keeps errors unless `all`). */
  const clear = useCallback(
    (all = false) => {
      for (const [key, item] of items.current) {
        if (item.phase === "done" || item.phase === "canceled" || (all && item.phase === "error")) {
          if (item.localUrl) URL.revokeObjectURL(item.localUrl);
          items.current.delete(key);
          files.current.delete(key);
        }
      }
      flush();
    },
    [flush]
  );

  useEffect(() => {
    alive.current = true;
    const xhrMap = xhrs.current;
    const itemMap = items.current;
    return () => {
      alive.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (pollTimer.current !== null) clearTimeout(pollTimer.current);
      for (const xhr of xhrMap.values()) xhr.abort();
      for (const item of itemMap.values()) if (item.localUrl) URL.revokeObjectURL(item.localUrl);
    };
  }, []);

  // Closing the tab mid-upload loses the files: ask first.
  const summary = queueSummary(snapshot);
  const uploading = summary.queued + summary.uploading > 0;
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  return { items: snapshot, summary, add, cancel, retry, clear };
}
