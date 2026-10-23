"use client";

/**
 * Jonli preview (spec FR-C12): a feed card for posts and carousels, a 9:16
 * frame for Reels and Stories with the safe zones, the caption shortened
 * with "…yana", the tagged people as pills.
 */

import { useState } from "react";
import { isFullFrame, tagsInCrop } from "@/lib/content/crop-geometry";
import type { PostDraft } from "./shared";

export default function Preview({ draft, username }: { draft: PostDraft; username: string }) {
  const [index, setIndex] = useState(0);
  const items = draft.media;
  const item = items[Math.min(index, Math.max(0, items.length - 1))];
  const vertical = draft.type === "REEL" || draft.type === "TRIAL_REEL" || draft.type === "STORY" || draft.type === "FEED_VIDEO";
  const caption = draft.caption.trim();
  const short = caption.length > 125 ? `${caption.slice(0, 125)}… yana` : caption;
  // FR-M4: show exactly the frame Instagram will get.
  const crop = item?.kind !== "VIDEO" && item?.cropRect && !isFullFrame(item.cropRect) && item.width && item.height ? item.cropRect : null;
  const frameStyle = crop && item?.width && item?.height ? { aspectRatio: `${crop.w * item.width} / ${crop.h * item.height}` } : undefined;
  const imgStyle = crop
    ? { position: "absolute" as const, width: `${100 / crop.w}%`, height: `${100 / crop.h}%`, left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%`, maxWidth: "none" }
    : undefined;
  const tags = item?.userTags ? tagsInCrop(item.userTags, crop) : [];

  return (
    <div className="mx-auto w-full max-w-[340px] rounded-2xl border border-border bg-background p-3 text-foreground">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="h-7 w-7 rounded-full bg-gradient-to-br from-primary to-accent" aria-hidden="true" />
        <span className="font-semibold">{username || "akkaunt"}</span>
        {draft.collaborators.length > 0 && <span className="text-muted">va {draft.collaborators.map((c) => `@${c}`).join(", ")}</span>}
      </div>
      <div className={`relative overflow-hidden rounded-lg bg-surface ${frameStyle ? "" : vertical ? "aspect-[9/16]" : "aspect-[4/5]"}`} style={frameStyle}>
        {item?.previewUrl || item?.thumbUrl ? (
          item.kind === "VIDEO" && item.previewUrl ? (
            <video src={item.previewUrl} className="h-full w-full object-cover" muted playsInline controls />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
            <img src={item.previewUrl ?? item.thumbUrl ?? ""} alt="" className={crop ? "" : "h-full w-full object-cover"} style={imgStyle} />
          )
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted">Media tanlanmagan</div>
        )}
        {tags.map((t, i) =>
          t.x !== undefined && t.y !== undefined ? (
            <span key={`${t.username}-${i}`} style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%` }} className="absolute -translate-x-1/2 rounded-full bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold">
              @{t.username}
            </span>
          ) : null
        )}
        {vertical && (
          <>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-[14%] border-b border-dashed border-foreground/20" aria-hidden="true" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[20%] border-t border-dashed border-foreground/20" aria-hidden="true" />
            <div className="pointer-events-none absolute bottom-2 left-2 right-14 text-[11px] text-foreground/90 drop-shadow">
              <div className="font-semibold">{username || "akkaunt"}</div>
              {draft.type !== "STORY" && short && <div className="line-clamp-2">{short}</div>}
            </div>
          </>
        )}
        {items.length > 1 && (
          <div className="absolute inset-x-0 bottom-2 flex justify-center gap-1">
            {items.map((_, i) => (
              <button key={i} type="button" aria-label={`${i + 1}-element`} onClick={() => setIndex(i)} className={`h-1.5 w-1.5 rounded-full ${i === index ? "bg-accent" : "bg-foreground/40"}`} />
            ))}
          </div>
        )}
      </div>
      {!vertical && (
        <div className="mt-2 space-y-1 text-xs">
          <div className="text-muted">♡ ◯ ⇧</div>
          {short && (
            <p>
              <span className="font-semibold">{username || "akkaunt"}</span> {short}
            </p>
          )}
          {draft.firstComment.trim() && draft.type !== "STORY" && (
            <p className="text-muted">
              <span className="font-semibold text-foreground">{username || "akkaunt"}</span> {draft.firstComment.trim().slice(0, 80)}
            </p>
          )}
        </div>
      )}
      {item?.userTags?.some((t) => t.x === undefined) && <p className="mt-2 text-[11px] text-muted">Belgilangan: {item.userTags.map((t) => `@${t.username}`).join(", ")}</p>}
    </div>
  );
}
