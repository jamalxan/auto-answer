"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A 2.5D stage: the pointer's position over the stage becomes two CSS
 * variables (--px, --py in −1…1) that each `.parallax` child turns into a
 * small translate, scaled by its own --shift. Far layers get a small shift,
 * near layers a large one, and the eye reads depth.
 *
 * Touch screens and reduced-motion users get the still composition: the
 * variables stay at 0 and nothing moves.
 */
export default function DepthStage({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section";
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      !window.matchMedia("(hover: hover) and (pointer: fine)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    let raf = 0;
    let px = 0;
    let py = 0;
    const paint = () => {
      el.style.setProperty("--px", px.toFixed(3));
      el.style.setProperty("--py", py.toFixed(3));
      raf = 0;
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      px = ((e.clientX - r.left) / r.width - 0.5) * 2;
      py = ((e.clientY - r.top) / r.height - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const leave = () => {
      px = 0;
      py = 0;
      if (!raf) raf = requestAnimationFrame(paint);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // One element type per render; the ref type covers both.
  return (
    <Tag ref={ref as React.RefObject<HTMLDivElement>} className={`depth-stage ${className}`}>
      {children}
    </Tag>
  );
}
