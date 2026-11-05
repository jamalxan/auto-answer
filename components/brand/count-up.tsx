"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A number that counts up from 0 the first time it scrolls into view.
 * Server-rendered with its final value, so without script, for crawlers and
 * for reduced-motion users the figure is simply there. Only a figure still
 * below the fold after mount drops to 0 and waits for the viewport.
 *
 * Prefix and suffix are plain strings (a server page renders this), e.g.
 * value 24 with suffix "/7".
 */
export default function CountUp({
  value,
  prefix = "",
  suffix = "",
  duration = 1200,
  className = "",
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  /** ms */
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;

    let raf = 0;
    setShown(0);
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / duration);
          // ease-out-expo, like the rest of the brand motion
          const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
          setShown(Math.round(value * eased));
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { rootMargin: "0px 0px -10% 0px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [value, duration]);

  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {prefix}
      {shown}
      {suffix}
    </span>
  );
}
