"use client";

/**
 * Odam belgilash (spec §10.3): click a point on the image to drop a
 * "@username" pill there, drag it around, × removes it. For types without
 * coordinates (Reels, Story) the same component renders a plain list.
 */

import { useRef, useState, type MouseEvent } from "react";
import { inputClass, secondaryButton } from "./ui";
import type { UserTag } from "./shared";

const USERNAME_RE = /^[a-zA-Z0-9._]{1,30}$/;

export default function TagEditor({
  imageUrl,
  tags,
  coords,
  onChange,
}: {
  imageUrl: string | null;
  tags: UserTag[];
  /** "required" = place on the image; "optional" / "none" = list only. */
  coords: "required" | "optional" | "none";
  onChange: (tags: UserTag[]) => void;
}) {
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  const clean = (raw: string) => raw.trim().replace(/^@+/, "");

  function commit(point: { x: number; y: number } | null) {
    const username = clean(name);
    if (!USERNAME_RE.test(username)) {
      setError("Username: faqat harf, raqam, nuqta va pastki chiziq (1–30)");
      return;
    }
    if (tags.some((t) => t.username.toLowerCase() === username.toLowerCase())) {
      setError("Bu odam allaqachon belgilangan");
      return;
    }
    onChange([...tags, point ? { username, x: round(point.x), y: round(point.y) } : { username }]);
    setName("");
    setPending(null);
    setError(null);
  }

  function pointOf(e: MouseEvent): { x: number; y: number } | null {
    const el = box.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }

  const placeOnImage = coords === "required" && imageUrl;

  return (
    <div className="space-y-2">
      {placeOnImage ? (
        <div
          ref={box}
          className="relative select-none overflow-hidden rounded-lg border border-border bg-background"
          onClick={(e) => {
            if (dragging.current !== null) return;
            const p = pointOf(e);
            if (p) setPending(p);
          }}
          onMouseMove={(e) => {
            if (dragging.current === null) return;
            const p = pointOf(e);
            if (!p) return;
            onChange(tags.map((t, i) => (i === dragging.current ? { ...t, x: round(p.x), y: round(p.y) } : t)));
          }}
          onMouseUp={() => {
            dragging.current = null;
          }}
          onMouseLeave={() => {
            dragging.current = null;
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL */}
          <img src={imageUrl} alt="" className="block max-h-96 w-full object-contain" draggable={false} />
          {tags.map((t, i) => (
            <span
              key={`${t.username}-${i}`}
              style={{ left: `${(t.x ?? 0.5) * 100}%`, top: `${(t.y ?? 0.5) * 100}%` }}
              className="absolute -translate-x-1/2 -translate-y-full cursor-move rounded-full bg-background/90 px-2 py-0.5 text-xs font-semibold text-foreground shadow"
              onMouseDown={(e) => {
                e.stopPropagation();
                dragging.current = i;
              }}
              onClick={(e) => e.stopPropagation()}
            >
              @{t.username}
              <button type="button" className="ml-1 text-muted hover:text-error" aria-label={`@${t.username} ni olib tashlash`} onClick={() => onChange(tags.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
          {pending && (
            <div style={{ left: `${pending.x * 100}%`, top: `${pending.y * 100}%` }} className="absolute z-10 -translate-x-1/2 rounded-lg border border-border bg-surface p-2 shadow-lg" onClick={(e) => e.stopPropagation()}>
              <input
                autoFocus
                className={`${inputClass} !w-44`}
                placeholder="@username"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit(pending);
                  if (e.key === "Escape") setPending(null);
                }}
              />
              <div className="mt-1 flex gap-1">
                <button type="button" className={secondaryButton} onClick={() => commit(pending)}>
                  Belgilash
                </button>
                <button type="button" className={secondaryButton} onClick={() => setPending(null)}>
                  Bekor
                </button>
              </div>
            </div>
          )}
          {tags.length === 0 && !pending && <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/80 px-2 py-0.5 text-[11px] text-muted">Rasm ustiga bosib odam belgilang</span>}
        </div>
      ) : (
        <div className="flex gap-1">
          <input
            className={inputClass}
            placeholder="@username"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commit(null))}
          />
          <button type="button" className={secondaryButton} onClick={() => commit(null)}>
            Qo&apos;shish
          </button>
        </div>
      )}
      {!placeOnImage && tags.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {tags.map((t, i) => (
            <li key={`${t.username}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs">
              @{t.username}
              <button type="button" className="text-muted hover:text-error" aria-label={`@${t.username} ni olib tashlash`} onClick={() => onChange(tags.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
      <p className="text-[11px] text-muted">Faqat ochiq akkauntlar belgilanadi; yopiq akkaunt bo&apos;lsa Instagram postni rad etadi.</p>
    </div>
  );
}

const round = (v: number) => Math.round(v * 10_000) / 10_000;
