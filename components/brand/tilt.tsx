"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Pointer-driven 3D tilt. The outer div is the perspective camera and the
 * scroll-linked "unfold"; the inner div rotates toward the cursor. Touch
 * screens and reduced-motion users get the static, upright composition.
 */
export default function Tilt({
  children,
  className = "",
  max = 6,
  unfold = true,
}: {
  children: ReactNode;
  className?: string;
  /** Max rotation in degrees on each axis. */
  max?: number;
  /** Scroll-linked stand-up on entry (CSS scroll timeline where supported). */
  unfold?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

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
    let rx = 0;
    let ry = 0;
    const paint = () => {
      el.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      raf = 0;
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      ry = px * max * 2;
      rx = -py * max * 2;
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const leave = () => {
      rx = 0;
      ry = 0;
      if (!raf) raf = requestAnimationFrame(paint);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [max]);

  return (
    <div className={`${unfold ? "unfold" : ""} [perspective:1600px]`}>
      <div
        ref={ref}
        className={`transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] [transform-style:preserve-3d] ${className}`}
      >
        {children}
      </div>
    </div>
  );
}
