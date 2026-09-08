"use client";

/**
 * ACTS — every piece of choreography on the site lives in this file.
 * Components never call gsap directly; they hand a scope ref to a hook.
 *
 * Discipline enforced here:
 *  · transform + opacity only (one documented exception: the patch-cable
 *    stroke-dashoffset in ACT 3 — paint-only, no layout).
 *  · reduced motion => hooks return early, DOM stays in final state.
 *  · every ScrollTrigger is scoped to its own section container.
 *  · ScrollTrigger.refresh() after fonts settle.
 */

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import type { RefObject } from "react";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
  if (document.fonts) {
    document.fonts.ready.then(() => ScrollTrigger.refresh());
  }
}

export const prefersReduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const isSmall = () =>
  typeof window !== "undefined" && window.innerWidth < 900;

/** Split a text node into per-character spans, once, without losing the text. */
export function splitChars(el: HTMLElement) {
  if (el.dataset.split === "1") return Array.from(el.querySelectorAll("i"));
  const raw = el.textContent ?? "";
  el.setAttribute("aria-label", raw);
  el.textContent = "";
  const frag = document.createDocumentFragment();
  raw.split("").forEach((ch) => {
    const i = document.createElement("i");
    i.textContent = ch === " " ? "\u00a0" : ch;
    i.style.display = "inline-block";
    i.style.willChange = "transform";
    i.setAttribute("aria-hidden", "true");
    frag.appendChild(i);
  });
  el.appendChild(frag);
  el.dataset.split = "1";
  return Array.from(el.querySelectorAll("i"));
}

/* ── ACT 1 · ARRIVAL — ~1.2s: chars, then plate settles, marginalia last ── */
export function useArrival(scope: RefObject<HTMLElement>) {
  useGSAP(
    () => {
      if (prefersReduced()) return;
      const head = scope.current?.querySelector<HTMLElement>("[data-split]");
      const chars = head ? splitChars(head) : [];
      const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
      tl.from(chars, {
        opacity: 0,
        y: 20,
        rotateX: -40,
        duration: 0.6,
        stagger: 0.015,
      })
        .from(
          "[data-arrival='plate']",
          { opacity: 0, y: 40, rotateY: -18, scale: 0.96, duration: 0.9 },
          0.15
        )
        .from(
          "[data-arrival='sub']",
          { opacity: 0, y: 18, duration: 0.5, ease: "power2.out" },
          0.5
        )
        .from(
          "[data-arrival='mark']",
          { opacity: 0, duration: 0.4, stagger: 0.05 },
          0.75
        )
        .set(chars, { clearProps: "willChange" });
    },
    { scope }
  );
}

/* ── ACT 2 · DESCENT — continuous parallax, background slowest ── */
export function useDescent(scope: RefObject<HTMLElement>) {
  useGSAP(
    () => {
      if (prefersReduced()) return;
      const layers = gsap.utils.toArray<HTMLElement>(
        scope.current!.querySelectorAll(".parallax-layer")
      );
      const cap = isSmall() ? 2 : layers.length; // mobile: 2 layers max
      layers.slice(0, cap).forEach((layer, i) => {
        gsap.to(layer, {
          yPercent: (i + 1) * -8,
          ease: "none",
          scrollTrigger: {
            trigger: layer.parentElement,
            scrub: 0.5,
            onToggle: (s) =>
              (layer.style.willChange = s.isActive ? "transform" : "auto"),
          },
        });
      });
    },
    { scope }
  );
}

/* ── ACT 3 · THE PIN — the only pin on the page. The signature. ── */
export function useKommutator(scope: RefObject<HTMLElement>) {
  useGSAP(
    () => {
      if (prefersReduced()) return;
      const section = scope.current!;
      // Mobile: pin count 1 -> 0. Same beats, played as a plain reveal.
      if (isSmall()) {
        gsap.from(section.querySelectorAll("[data-patch]"), {
          opacity: 0,
          y: 18,
          duration: 0.45,
          stagger: 0.08,
          scrollTrigger: { trigger: section, start: "top 80%" },
        });
        return;
      }

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: section,
          start: "top top",
          end: "+=180%",
          scrub: 1,
          pin: true,
          anticipatePin: 1,
        },
      });

      tl.fromTo(
        "[data-patch='panel']",
        { rotateY: -22, rotateX: 6 },
        { rotateY: 6, rotateX: 1, duration: 1.6, ease: "none" },
        0
      )
        // paint-only exception, documented in README: the cable draws itself
        .to("[data-patch='cable']", { strokeDashoffset: 0, duration: 1.0, ease: "none" }, 0.1)
        // plug travels in SVG user units along the cable (viewBox 0 0 600 360)
        .to("[data-patch='plug']", { x: 452, y: 214, duration: 1.0, ease: "none" }, 0.1)
        .to("[data-patch='lamp-1']", { opacity: 1, duration: 0.05 }, 0.25)
        .to("[data-patch='lamp-2']", { opacity: 1, duration: 0.05 }, 0.6)
        .to("[data-patch='lamp-3']", { opacity: 1, duration: 0.05 }, 1.05)
        .to("[data-patch='dial']", { rotate: 318, duration: 0.9, ease: "none" }, 0.35)
        .from(
          "[data-patch='bubble'] > *",
          { opacity: 0, y: 12, duration: 0.3, stagger: 0.22, ease: "none" },
          0.55
        )
        .to("[data-patch='caption']", { yPercent: -12, duration: 1.6, ease: "none" }, 0);

      // the 24h window counter counts down against scroll, not time
      const proxy = { h: 24 };
      const out = section.querySelector<HTMLElement>("[data-patch='clock']");
      tl.to(
        proxy,
        {
          h: 0.2,
          duration: 0.9,
          ease: "none",
          onUpdate: () => {
            if (out) out.textContent = `${proxy.h.toFixed(1)} soat qoldi`;
          },
        },
        0.35
      );
    },
    { scope }
  );
}

/* ── ACT 4 · SWARM — bento enters as a staggered wave from the centre ── */
export function useSwarm(scope: RefObject<HTMLElement>) {
  useGSAP(
    () => {
      if (prefersReduced()) return;
      gsap.from(scope.current!.querySelectorAll(".grid-item"), {
        opacity: 0,
        scale: 0.92,
        y: 16,
        duration: 0.4,
        stagger: { each: 0.06, from: "center", grid: "auto" },
        ease: "back.out(1.4)",
        scrollTrigger: { trigger: scope.current, start: "top 78%" },
      });
    },
    { scope }
  );
}

/* ── ACT 5 · LANDING — everything decelerates; only the CTA still breathes ── */
export function useQuiet(scope: RefObject<HTMLElement>) {
  useGSAP(
    () => {
      if (prefersReduced()) return;
      gsap.from(scope.current!.querySelectorAll("[data-quiet] > *"), {
        opacity: 0,
        y: 24,
        duration: 0.5,
        stagger: 0.08,
        ease: "power2.out",
        scrollTrigger: { trigger: scope.current, start: "top 85%" },
      });
      gsap.to("[data-quiet='cta']", {
        scale: 1.02,
        duration: 1.6,
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut",
      });
    },
    { scope }
  );
}

/* ── panel-side: one short entrance, nothing scroll-scrubbed in the app ── */
export function usePanelEntrance(scope: RefObject<HTMLElement>) {
  useGSAP(
    () => {
      if (prefersReduced() || !scope.current) return;
      gsap.from(scope.current.querySelectorAll("[data-bay]"), {
        opacity: 0,
        y: 14,
        duration: 0.34,
        stagger: 0.045,
        ease: "power2.out",
      });
    },
    { scope }
  );
}

/* ── cursor tilt with damping (lerp 0.08) — desktop, pointer:fine only ── */
export function useTilt(scope: RefObject<HTMLElement>, selector: string) {
  useGSAP(
    () => {
      if (prefersReduced() || !window.matchMedia("(pointer:fine)").matches) return;
      const el = scope.current!.querySelector<HTMLElement>(selector);
      if (!el) return;
      const target = { x: 0, y: 0 };
      const current = { x: 0, y: 0 };
      const onMove = (e: PointerEvent) => {
        const r = scope.current!.getBoundingClientRect();
        target.x = ((e.clientX - r.left) / r.width - 0.5) * 12;
        target.y = ((e.clientY - r.top) / r.height - 0.5) * -8;
      };
      window.addEventListener("pointermove", onMove);
      const tick = () => {
        current.x += (target.x - current.x) * 0.08;
        current.y += (target.y - current.y) * 0.08;
        gsap.set(el, { rotateY: `+=0`, "--tilt-x": current.x } as never);
        el.style.transform = `rotateY(${current.x}deg) rotateX(${current.y}deg)`;
      };
      gsap.ticker.add(tick);
      return () => {
        window.removeEventListener("pointermove", onMove);
        gsap.ticker.remove(tick);
      };
    },
    { scope }
  );
}
