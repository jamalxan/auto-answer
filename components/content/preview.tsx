"use client";

/**
 * Jonli preview (spec FR-C12): the post as the network will show it. Instagram
 * has its own layout for a feed post, a carousel, a Reel and a Story; Facebook,
 * Threads and YouTube follow the format the cross-post sends them (a Reel is a
 * Reel on Facebook and a Short on YouTube, a video is a plain post on Threads).
 * The media is the real file: a video plays muted on a loop over its poster, an
 * image shows the exact crop Instagram will get (FR-M4).
 */

import { useState, type ReactNode } from "react";
import { isFullFrame, tagsInCrop } from "@/lib/content/crop-geometry";
import { formatFor, threadsText, youtubeTitle, type PreviewPlatform } from "@/lib/content/platform-preview";
import type { MediaItemDraft, PostDraft } from "./shared";

const PHONE = "mx-auto w-full max-w-[340px] overflow-hidden rounded-[28px] border border-white/10 bg-black text-white shadow-lg";

function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#feda75] via-[#d62976] to-[#4f5bd5] text-[11px] font-bold uppercase text-white"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {name.trim().charAt(0) || "·"}
    </span>
  );
}

/** One photo or video, filling its box. Falls back to the thumbnail when the file does not load. */
function MediaView({ item, fit = "cover", crop }: { item?: MediaItemDraft; fit?: "cover" | "contain"; crop?: { x: number; y: number; w: number; h: number } | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (!item) return <div className="flex h-full min-h-40 items-center justify-center bg-neutral-900 text-xs text-neutral-400">Media tanlanmagan</div>;
  if (item.status && item.status !== "READY") {
    return <div className="flex h-full min-h-40 items-center justify-center bg-neutral-900 px-4 text-center text-xs text-neutral-400">Fayl tayyorlanmoqda…</div>;
  }
  const poster = item.thumbUrl ?? undefined;
  const fitClass = fit === "contain" ? "object-contain" : "object-cover";
  if (item.kind === "VIDEO") {
    if (item.previewUrl && broken !== item.previewUrl) {
      return <video key={item.previewUrl} src={item.previewUrl} poster={poster} className={`h-full w-full ${fitClass}`} autoPlay muted loop playsInline preload="metadata" onError={() => setBroken(item.previewUrl ?? "")} />;
    }
    return poster ? (
      // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
      <img src={poster} alt="" className={`h-full w-full ${fitClass}`} />
    ) : (
      <div className="flex h-full min-h-40 items-center justify-center bg-neutral-900 px-4 text-center text-xs text-neutral-400">Video ko&apos;rsatib bo&apos;lmadi</div>
    );
  }
  const src = (broken === item.previewUrl ? item.thumbUrl : (item.previewUrl ?? item.thumbUrl)) ?? "";
  if (!src) return <div className="flex h-full min-h-40 items-center justify-center bg-neutral-900 text-xs text-neutral-400">Rasm yo&apos;q</div>;
  const style = crop
    ? { position: "absolute" as const, width: `${100 / crop.w}%`, height: `${100 / crop.h}%`, left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%`, maxWidth: "none" }
    : undefined;
  // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
  return <img src={src} alt="" className={crop ? "" : `h-full w-full ${fitClass}`} style={style} onError={() => setBroken(item.previewUrl ?? "")} />;
}

function Dots({ count, index, onPick }: { count: number; index: number; onPick: (i: number) => void }) {
  if (count < 2) return null;
  return (
    <div className="flex justify-center gap-1 py-1.5">
      {Array.from({ length: count }, (_, i) => (
        <button key={i} type="button" aria-label={`${i + 1}-element`} onClick={() => onPick(i)} className={`h-1.5 w-1.5 rounded-full ${i === index ? "bg-[#0095f6]" : "bg-white/35"}`} />
      ))}
    </div>
  );
}

function Rail({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="absolute bottom-16 right-2 flex flex-col items-center gap-4 text-[11px] font-medium drop-shadow">
      {items.map(([icon, label]) => (
        <div key={icon} className="flex flex-col items-center">
          <span className="text-2xl leading-none">{icon}</span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function shorten(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}… yana` : text;
}

interface Ctx {
  draft: PostDraft;
  name: string;
  item?: MediaItemDraft;
  index: number;
  setIndex: (i: number) => void;
  caption: string;
}

// ── Instagram ───────────────────────────────────────────────────────────────

function InstagramFeed({ draft, name, item, index, setIndex, caption }: Ctx) {
  // FR-M4: show exactly the frame Instagram will get.
  const crop = item?.kind !== "VIDEO" && item?.cropRect && !isFullFrame(item.cropRect) && item.width && item.height ? item.cropRect : null;
  const ratio = crop && item?.width && item?.height ? `${crop.w * item.width} / ${crop.h * item.height}` : "4 / 5";
  const tags = item?.userTags ? tagsInCrop(item.userTags, crop) : [];
  const count = draft.media.length;
  return (
    <div className={PHONE}>
      <div className="flex items-center gap-2 px-3 py-2.5 text-[13px]">
        <Avatar name={name} />
        <div className="min-w-0 flex-1 leading-tight">
          <span className="font-semibold">{name}</span>
          {draft.collaborators.length > 0 && <span className="text-white/70"> va {draft.collaborators.map((c) => `@${c}`).join(", ")}</span>}
          {draft.type === "FEED_VIDEO" && <div className="text-[11px] text-white/60">Video</div>}
        </div>
        <span className="text-lg leading-none">⋯</span>
      </div>
      <div className="relative w-full overflow-hidden bg-neutral-900" style={{ aspectRatio: ratio }}>
        <MediaView item={item} crop={crop} />
        {count > 1 && <span className="absolute right-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-medium">{index + 1}/{count}</span>}
        {tags.map((t, i) =>
          t.x !== undefined && t.y !== undefined ? (
            <span key={`${t.username}-${i}`} style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }} className="absolute -translate-x-1/2 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold">
              {t.username}
            </span>
          ) : null
        )}
      </div>
      <Dots count={count} index={index} onPick={setIndex} />
      <div className="flex items-center gap-4 px-3 pb-1 pt-1.5 text-xl leading-none">
        <span>♡</span>
        <span>💬</span>
        <span>➤</span>
        <span className="ml-auto">🔖</span>
      </div>
      <div className="space-y-1 px-3 pb-3 text-[13px]">
        <div className="font-semibold">0 ta layk</div>
        {caption && (
          <p>
            <span className="font-semibold">{name}</span> {shorten(caption, 125)}
          </p>
        )}
        {draft.firstComment.trim() && (
          <p className="text-white/70">
            <span className="font-semibold text-white">{name}</span> {draft.firstComment.trim().slice(0, 80)}
          </p>
        )}
        <div className="text-[11px] uppercase text-white/50">Hozir</div>
        {item?.userTags?.some((t) => t.x === undefined) && <p className="text-[11px] text-white/60">Belgilangan: {item.userTags.map((t) => `@${t.username}`).join(", ")}</p>}
      </div>
    </div>
  );
}

function InstagramReel({ draft, name, item, caption }: Ctx) {
  return (
    <div className={`${PHONE} relative aspect-[9/16]`}>
      <div className="absolute inset-0">
        <MediaView item={item} />
      </div>
      <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/50 to-transparent px-4 pb-6 pt-4 text-base font-bold">
        <span>Reels</span>
        <span>📷</span>
      </div>
      <Rail items={[["♡", "0"], ["💬", "0"], ["➤", ""], ["⋯", ""]]} />
      <div className="absolute inset-x-0 bottom-0 space-y-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 pb-3 pt-10 pr-16 text-[13px]">
        <div className="flex items-center gap-2">
          <Avatar name={name} size={26} />
          <span className="font-semibold">{name}</span>
          {draft.collaborators.length > 0 && <span className="text-white/80">va {draft.collaborators.map((c) => `@${c}`).join(", ")}</span>}
          <span className="rounded-md border border-white/70 px-2 py-0.5 text-[11px] font-semibold">Kuzatish</span>
        </div>
        {caption && <p className="line-clamp-2">{shorten(caption, 125)}</p>}
        <div className="flex items-center gap-1 text-[11px] text-white/85">
          <span>♫</span>
          <span className="truncate">{`${name} · Original audio`}</span>
        </div>
        {draft.type === "TRIAL_REEL" && <div className="text-[11px] text-white/70">Sinov Reel — avval obuna bo&apos;lmaganlarga ko&apos;rsatiladi</div>}
      </div>
    </div>
  );
}

function InstagramStory({ draft, name, item }: Ctx) {
  const count = Math.max(1, draft.media.length);
  return (
    <div className={`${PHONE} relative aspect-[9/16]`}>
      <div className="absolute inset-0">
        <MediaView item={item} />
      </div>
      <div className="absolute inset-x-0 top-0 space-y-2 bg-gradient-to-b from-black/55 to-transparent px-3 pb-8 pt-3">
        <div className="flex gap-1">
          {Array.from({ length: count }, (_, i) => (
            <span key={i} className="h-0.5 flex-1 rounded-full bg-white/40">
              {i === 0 && <span className="block h-full w-1/3 rounded-full bg-white" />}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <Avatar name={name} size={30} />
          <span className="font-semibold">{name}</span>
          <span className="text-white/70">hozir</span>
          <span className="ml-auto text-lg leading-none">⋯ ✕</span>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/60 to-transparent px-3 pb-3 pt-10 text-sm">
        <span className="flex-1 rounded-full border border-white/70 px-4 py-2 text-[13px] text-white/90">Xabar yuborish</span>
        <span className="text-xl">♡</span>
        <span className="text-xl">➤</span>
      </div>
    </div>
  );
}

// ── Facebook ────────────────────────────────────────────────────────────────

function FacebookPost({ draft, name, item, index, setIndex, caption }: Ctx) {
  const count = draft.media.length;
  const vertical = item && item.width && item.height ? item.height > item.width : draft.type !== "FEED_IMAGE";
  return (
    <div className={`${PHONE} bg-[#18191a]`}>
      <div className="flex items-center gap-2 px-3 py-2.5 text-[13px]">
        <Avatar name={name} size={36} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="font-semibold">{name}</div>
          <div className="text-[11px] text-white/60">Hozir · 🌐</div>
        </div>
        <span className="text-lg leading-none">⋯</span>
      </div>
      {caption && <p className="whitespace-pre-line px-3 pb-2 text-[14px]">{shorten(caption, 240)}</p>}
      {count > 0 && (
        <div className="relative w-full overflow-hidden bg-black" style={{ aspectRatio: vertical ? "4 / 5" : "1 / 1" }}>
          <MediaView item={item} fit={vertical ? "contain" : "cover"} />
          {count > 1 && <span className="absolute right-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-medium">{index + 1}/{count}</span>}
        </div>
      )}
      <Dots count={count} index={index} onPick={setIndex} />
      <div className="mx-3 flex justify-between border-b border-white/10 py-1.5 text-[12px] text-white/60">
        <span>👍 0</span>
        <span>0 izoh · 0 ulashish</span>
      </div>
      <div className="flex justify-around py-2 text-[13px] font-medium text-white/70">
        <span>👍 Yoqdi</span>
        <span>💬 Izoh</span>
        <span>↗ Ulashish</span>
      </div>
    </div>
  );
}

function FacebookReel({ name, item, caption }: Ctx) {
  return (
    <div className={`${PHONE} relative aspect-[9/16]`}>
      <div className="absolute inset-0">
        <MediaView item={item} />
      </div>
      <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/50 to-transparent px-4 pb-6 pt-4 text-base font-bold">
        <span>Reels</span>
        <span>🔍</span>
      </div>
      <Rail items={[["👍", "0"], ["💬", "0"], ["↗", "0"]]} />
      <div className="absolute inset-x-0 bottom-0 space-y-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 pb-3 pt-10 pr-16 text-[13px]">
        <div className="flex items-center gap-2">
          <Avatar name={name} size={30} />
          <span className="font-semibold">{name}</span>
          <span className="rounded-md bg-white/25 px-2 py-0.5 text-[11px] font-semibold">Kuzatish</span>
        </div>
        {caption && <p className="line-clamp-2">{shorten(caption, 125)}</p>}
      </div>
    </div>
  );
}

// ── Threads ─────────────────────────────────────────────────────────────────

function ThreadsPost({ draft, name, item, index, setIndex, caption }: Ctx) {
  const { text, cut } = threadsText(caption);
  const count = draft.media.length;
  const vertical = draft.type !== "FEED_IMAGE" && draft.type !== "CAROUSEL";
  return (
    <div className={`${PHONE} rounded-2xl bg-[#101010]`}>
      <div className="flex gap-3 px-3 py-3 text-[14px]">
        <div className="flex flex-col items-center">
          <Avatar name={name} size={34} />
          <span className="mt-2 w-0.5 flex-1 rounded bg-white/15" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{name}</span>
            <span className="text-white/50">hozir</span>
            <span className="ml-auto text-white/60">⋯</span>
          </div>
          {text && <p className="whitespace-pre-line">{text}</p>}
          {cut && <p className="text-[11px] text-[#ff7a7a]">Threads 500 belgidan keyin kesadi</p>}
          {count > 0 && (
            <div className="relative overflow-hidden rounded-xl bg-neutral-900" style={{ aspectRatio: vertical ? "9 / 14" : "4 / 5" }}>
              <MediaView item={item} />
              {count > 1 && <span className="absolute right-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-medium">{index + 1}/{count}</span>}
            </div>
          )}
          <Dots count={count} index={index} onPick={setIndex} />
          <div className="flex gap-5 text-lg text-white/80">
            <span>♡</span>
            <span>💬</span>
            <span>⇄</span>
            <span>➤</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── YouTube ─────────────────────────────────────────────────────────────────

function YouTubeVideo({ name, item, caption }: Ctx) {
  const title = youtubeTitle(caption, "video");
  const description = caption.trim().split("\n").slice(1).join(" ").trim();
  return (
    <div className={`${PHONE} rounded-2xl bg-[#0f0f0f]`}>
      <div className="relative aspect-video w-full bg-black">
        <MediaView item={item} fit="contain" />
      </div>
      <div className="space-y-2 px-3 py-3">
        <h3 className="text-[15px] font-semibold leading-snug">{title}</h3>
        <div className="text-[11px] text-white/60">0 ko&apos;rish · hozir</div>
        <div className="flex items-center gap-2 text-[13px]">
          <Avatar name={name} size={30} />
          <span className="font-medium">{name}</span>
          <span className="ml-auto rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-black">Obuna bo&apos;lish</span>
        </div>
        <div className="flex gap-2 text-[12px]">
          <span className="rounded-full bg-white/10 px-3 py-1">👍 0 | 👎</span>
          <span className="rounded-full bg-white/10 px-3 py-1">↗ Ulashish</span>
        </div>
        {description && <p className="line-clamp-3 rounded-lg bg-white/10 p-2 text-[12px] text-white/80">{description}</p>}
      </div>
    </div>
  );
}

function YouTubeShort({ name, item, caption }: Ctx) {
  return (
    <div className={`${PHONE} relative aspect-[9/16]`}>
      <div className="absolute inset-0">
        <MediaView item={item} />
      </div>
      <Rail items={[["👍", "0"], ["👎", ""], ["💬", "0"], ["↗", ""]]} />
      <div className="absolute inset-x-0 bottom-0 space-y-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 pb-3 pt-10 pr-16 text-[13px]">
        <div className="flex items-center gap-2">
          <Avatar name={name} size={26} />
          <span className="font-semibold">@{name}</span>
          <span className="rounded-full bg-white px-2.5 py-0.5 text-[11px] font-semibold text-black">Obuna bo&apos;lish</span>
        </div>
        <p className="line-clamp-2 font-medium">{youtubeTitle(caption, "short")}</p>
      </div>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mx-auto mt-2 max-w-[340px] text-center text-[11px] text-muted">{children}</p>;
}

export default function Preview({ draft, username, platform = "instagram", accountLabel }: { draft: PostDraft; username: string; platform?: PreviewPlatform; accountLabel?: string }) {
  const [index, setIndexRaw] = useState(0);
  const items = draft.media;
  const item = items[Math.min(index, Math.max(0, items.length - 1))];
  const setIndex = (i: number) => setIndexRaw(Math.max(0, Math.min(i, items.length - 1)));
  const caption = draft.caption.trim();
  const name = (platform === "instagram" ? username : (accountLabel ?? username)) || "akkaunt";
  const ctx: Ctx = { draft, name, item, index: Math.min(index, Math.max(0, items.length - 1)), setIndex, caption };

  if (platform === "instagram") {
    if (draft.type === "STORY") return <InstagramStory {...ctx} />;
    if (draft.type === "REEL" || draft.type === "TRIAL_REEL") return <InstagramReel {...ctx} />;
    return <InstagramFeed {...ctx} />;
  }
  const format = formatFor(draft.type, platform, items.length > 0);
  if (platform === "facebook") {
    return (
      <>
        {format === "reel" ? <FacebookReel {...ctx} /> : <FacebookPost {...ctx} />}
        {format === "reel" && <Note>Facebook&apos;ga Reels sifatida chiqadi</Note>}
      </>
    );
  }
  if (platform === "threads") return <ThreadsPost {...ctx} />;
  return (
    <>
      {format === "short" ? <YouTubeShort {...ctx} /> : <YouTubeVideo {...ctx} />}
      <Note>{format === "short" ? "YouTube'ga Shorts sifatida chiqadi (#Shorts avtomatik qo'shiladi)" : "Sarlavha — izohning birinchi qatori"}</Note>
    </>
  );
}
