"use client";

/**
 * Kesish (FR-M4): pick a ratio, then drag the frame over the picture. The
 * asset itself is never changed — the 0–1 rectangle travels with the post
 * and the publisher cuts the image just before Instagram fetches it.
 */

import { useRef, type PointerEvent } from "react";
import { secondaryButton } from "./ui";
import { centerCrop, CROP_PRESETS, type CropRect } from "@/lib/content/crop-geometry";

export type CropChoice = { label: string; ratio: number };

/** Ratios that make sense for the post type (feed accepts 4:5 … 1.91:1, story is 9:16). */
export function presetsFor(story: boolean): CropChoice[] {
  return CROP_PRESETS.filter((p) => (story ? p.label === "9:16" || p.label === "1:1" || p.label === "4:5" : p.label !== "9:16")).map((p) => ({ label: p.label, ratio: p.ratio }));
}

const EDITOR_MAX_HEIGHT = 360;
const round4 =(n: number) => Math.round(n * 10_000) / 10_000;

/** Which preset the rectangle matches, if any. */
export function presetOf(rect: CropRect | null | undefined, width: number, height: number, presets: CropChoice[]): string | null {
  if (!rect) return null;
  const r = (rect.w * width) / (rect.h * height);
  return presets.find((p) => Math.abs(p.ratio - r) < 0.01)?.label ?? null;
}

export default function CropEditor({
  imageUrl,
  width,
  height,
  rect,
  presets,
  onChange,
}: {
  imageUrl: string | null;
  width: number;
  height: number;
  rect: CropRect | null;
  presets: CropChoice[];
  onChange: (rect: CropRect | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const active = presetOf(rect, width, height, presets);

  function onDown(e: PointerEvent<HTMLDivElement>) {
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: rect.x, y: rect.y };
  }

  function onMove(e: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    const el = box.current;
    if (!start || !rect || !el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(1 - rect.w, Math.max(0, start.x + (e.clientX - start.px) / r.width));
    const y = Math.min(1 - rect.h, Math.max(0, start.y + (e.clientY - start.py) / r.height));
    onChange({ ...rect, x: round4(x), y: round4(y) });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={`${secondaryButton} !px-2 !py-1 text-xs ${active === null && !rect ? "!border-accent text-accent" : ""}`} onClick={() => onChange(null)}>
          Asl
        </button>
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`${secondaryButton} !px-2 !py-1 text-xs ${active === p.label ? "!border-accent text-accent" : ""}`}
            aria-pressed={active === p.label}
            onClick={() => onChange(centerCrop(width, height, p.ratio))}
          >
            {p.label}
          </button>
        ))}
        {rect && <span className="text-[11px] text-muted">Ramkani surib joyini tanlang</span>}
      </div>
      {imageUrl && (
        <div
          ref={box}
          className="relative mx-auto select-none overflow-hidden rounded-lg border border-border bg-background"
          style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, ${Math.round((EDITOR_MAX_HEIGHT * width) / height)}px)` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL */}
          <img src={imageUrl} alt="" className="pointer-events-none h-full w-full object-fill" draggable={false} />
          {rect && (
            <div
              role="slider"
              aria-label="Kesish ramkasi"
              aria-valuenow={Math.round((rect.w < 1 ? rect.x : rect.y) * 100)}
              tabIndex={0}
              className="absolute cursor-move touch-none border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
              style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onKeyDown={(e) => {
                const step = 0.02;
                const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
                if (!d) return;
                e.preventDefault();
                onChange({ ...rect, x: round4(Math.min(1 - rect.w, Math.max(0, rect.x + d[0]))), y: round4(Math.min(1 - rect.h, Math.max(0, rect.y + d[1]))) });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
