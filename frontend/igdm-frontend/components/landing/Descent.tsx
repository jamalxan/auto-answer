"use client";

import { useRef } from "react";
import { useDescent } from "@/components/motion/useActs";

const FACTS: [string, string, string][] = [
  [
    "24",
    "soatlik oyna",
    "Meta faqat shu vaqt ichida javob yozishga ruxsat beradi. Kechikdingiz — odam yo'qoldi.",
  ],
  [
    "200+",
    "izoh bitta Reels ostida",
    "Har biriga qo'lda yozish — bir kecha ish. Ertalab yarmi javobsiz qoladi.",
  ],
  [
    "$29",
    "oyiga, ManyChat'da",
    "Kontakt bazangiz o'sgani sari narx ham o'sadi. Bu esa sizniki — bir marta o'rnatilgan.",
  ],
];

/* ACT 2 · DESCENT — four layers drift, body copy never moves. */
export default function Descent() {
  const scope = useRef<HTMLElement>(null);
  useDescent(scope);

  return (
    <section
      ref={scope}
      className="relative grain bleed overflow-hidden py-24 md:py-36"
      style={{
        background: "var(--c-field-deep)",
        ["--bleed-to" as string]: "var(--c-madder)",
      }}
    >
      {/* layer 1 — slowest: oversized ikat comb */}
      <div
        aria-hidden
        className="parallax-layer absolute -top-24 inset-x-0 h-[140%] opacity-25 pointer-events-none"
        style={{
          background:
            "repeating-linear-gradient(115deg, var(--c-field-lift) 0 18px, transparent 18px 46px)",
        }}
      />
      {/* layer 2 — the running count */}
      <div
        aria-hidden
        className="parallax-layer absolute right-[-6vw] top-10 display text-[26vw] leading-none opacity-[0.12] select-none pointer-events-none"
      >
        01:14
      </div>
      {/* layer 3 — madder slab */}
      <div
        aria-hidden
        className="parallax-layer absolute left-[-10vw] bottom-0 w-[42vw] h-[52vh] pointer-events-none"
        style={{ background: "var(--c-madder)", opacity: 0.22, transform: "rotate(-6deg)" }}
      />

      <div className="relative mx-auto max-w-[1320px] px-5 md:px-8">
        <p className="util text-saffron mb-6">hozir nima bo'lyapti</p>
        <h2 className="display text-[clamp(2.2rem,5.6vw,4.6rem)] measure">
          Kecha soat birda telefon qo'lingizda.
        </h2>
        <p className="mt-6 text-b-1 measure text-paper/80">
          Reels yaxshi ketdi, izohlar oqib keldi. Endi har biriga «direktni
          tekshiring» deb yozib chiqish kerak. Ertalabgacha yarmi sovuydi.
        </p>

        {/* layer 4 — foreground: real constraints from the platform */}
        <div className="parallax-layer mt-14 grid md:grid-cols-3 gap-4">
          {FACTS.map(([n, l, b]) => (
            <article
              key={n}
              className="plate rounded-bay p-5"
              style={{ background: "rgba(38,42,149,.5)" }}
            >
              <p className="display text-d-2" style={{ color: "var(--c-saffron)" }}>
                {n}
              </p>
              <p className="util mt-1 text-paper/60">{l}</p>
              <p className="mt-3 text-[15px] leading-relaxed text-paper/85">{b}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
