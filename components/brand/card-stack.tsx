"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A deck of sticky cards. Each card pins a little lower than the one before
 * it, and as the next card slides over, the covered card recedes: the
 * client writes --cover (0…1) on every card from the scroll position, the
 * CSS turns it into a small scale-down and a dim. Without script or with
 * reduced motion the cards still stack; they just do not recede.
 *
 * Children must carry `data-stack-card` and `style={{ "--i": index }}`.
 */
export default function CardStack({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-stack-card]"));
    if (cards.length < 2) return;

    let raf = 0;
    const paint = () => {
      raf = 0;
      for (let i = 0; i < cards.length - 1; i += 1) {
        const a = cards[i].getBoundingClientRect();
        const b = cards[i + 1].getBoundingClientRect();
        // How much of card i the next card has already covered.
        const cover = Math.min(1, Math.max(0, (a.bottom - b.top) / a.height));
        cards[i].style.setProperty("--cover", cover.toFixed(3));
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(paint);
    };
    paint();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
