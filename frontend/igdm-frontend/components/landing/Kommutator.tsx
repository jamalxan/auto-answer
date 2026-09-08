"use client";

import { useRef } from "react";
import { useKommutator } from "@/components/motion/useActs";

/**
 * ACT 3 · THE PIN — and the SIGNATURE of the whole site.
 *
 * KOMMUTATOR: a telephone switchboard. Scroll drags one patch cable from the
 * comment jack, through the condition jack, into the link jack. Three lamps
 * light in the real order the backend fires them; the 24-hour messaging window
 * starts draining the moment the cable seats. Nothing here is invented —
 * it is the funnel, drawn as the machine it actually is.
 */
export default function Kommutator() {
  const scope = useRef<HTMLElement>(null);
  useKommutator(scope);

  return (
    <section
      ref={scope}
      id="kommutator"
      className="relative grain overflow-hidden min-h-[100svh] flex items-center py-16"
      style={{ background: "var(--c-madder)" }}
    >
      <div className="relative mx-auto max-w-[1320px] w-full px-5 md:px-8">
        <div data-patch="caption" className="mb-8 md:mb-10">
          <p className="util" style={{ color: "var(--c-field-deep)" }}>
            kommutator · bitta izohning yo'li
          </p>
          <h2
            className="display text-[clamp(2rem,5vw,4rem)] mt-2"
            style={{ color: "var(--c-paper)" }}
          >
            Kabel ulanadi, oyna ochiladi.
          </h2>
        </div>

        <div className="grid lg:grid-cols-[1.15fr_.85fr] gap-6 items-stretch">
          {/* ── the panel ── */}
          <div className="rig">
            <div
              data-patch="panel"
              className="relative plate plate-specular rounded-bay p-4 md:p-6"
            >
              <svg
                viewBox="0 0 600 360"
                className="w-full h-auto"
                role="img"
                aria-label="Kalit so'z jaki shart jakiga, u yerdan havola jakiga kabel bilan ulanadi"
              >
                {/* milled panel grooves */}
                {[80, 160, 240, 320].map((y) => (
                  <line
                    key={y}
                    x1="20"
                    x2="580"
                    y1={y}
                    y2={y}
                    stroke="var(--c-line)"
                    strokeWidth="1"
                  />
                ))}

                {/* the cable */}
                <path
                  data-patch="cable"
                  d="M96 96 C 240 96, 200 250, 340 250 S 480 300, 520 306"
                  fill="none"
                  stroke="var(--c-saffron)"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray="760"
                  strokeDashoffset="760"
                />

                {/* jacks */}
                {[
                  { x: 96, y: 96, k: "01", t: "kalit so'z", lamp: "lamp-1" },
                  { x: 340, y: 250, k: "02", t: "shart", lamp: "lamp-2" },
                  { x: 520, y: 306, k: "03", t: "havola", lamp: "lamp-3" },
                ].map((j) => (
                  <g key={j.k}>
                    <circle
                      cx={j.x}
                      cy={j.y}
                      r="26"
                      fill="var(--c-field-deep)"
                      stroke="var(--c-saffron)"
                      strokeWidth="3"
                    />
                    <circle
                      data-patch={j.lamp}
                      cx={j.x}
                      cy={j.y}
                      r="11"
                      fill="var(--c-signal)"
                      opacity="0"
                    />
                    <text
                      x={j.x}
                      y={j.y - 40}
                      textAnchor="middle"
                      fill="var(--c-paper)"
                      fontFamily="var(--f-util)"
                      fontSize="13"
                      letterSpacing="1.5"
                    >
                      {j.k} {j.t.toUpperCase()}
                    </text>
                  </g>
                ))}

                {/* the plug that travels */}
                <g data-patch="plug">
                  <rect x="76" y="86" width="40" height="20" rx="4" fill="var(--c-paper)" />
                  <rect x="112" y="92" width="16" height="8" rx="2" fill="var(--c-saffron)" />
                </g>
              </svg>

              {/* the window dial — real constraint, drawn as an instrument */}
              <div className="mt-4 flex items-center gap-4 flex-wrap">
                <div className="relative w-16 h-16 shrink-0">
                  <div
                    className="absolute inset-0 rounded-jack border-2"
                    style={{ borderColor: "var(--c-saffron)" }}
                    aria-hidden
                  />
                  <div
                    data-patch="dial"
                    className="absolute left-1/2 top-1/2 w-[2px] h-6 origin-top"
                    style={{ background: "var(--c-signal)", transform: "translate(-50%,0)" }}
                    aria-hidden
                  />
                </div>
                <p className="util text-paper/70">
                  javob oynasi ·{" "}
                  <span data-patch="clock" style={{ color: "var(--c-signal)" }}>
                    24.0 soat qoldi
                  </span>
                </p>
              </div>
            </div>
          </div>

          {/* ── what the person sees, in the same second ── */}
          <div
            className="rounded-bay p-4 md:p-5 flex flex-col"
            style={{ background: "var(--c-field-deep)", border: "1px solid var(--c-line)" }}
          >
            <p className="util text-paper/55 mb-3">@dilnoza_s ning ekrani</p>
            <div data-patch="bubble" className="space-y-3">
              <div className="text-[15px]">
                <p className="util text-saffron/80 mb-1">izoh</p>
                <p
                  className="px-3 py-2 rounded-bay"
                  style={{ background: "var(--c-field-lift)" }}
                >
                  Tizimly
                </p>
              </div>
              <div className="text-[15px]">
                <p className="util text-saffron/80 mb-1">ochiq javob</p>
                <p
                  className="px-3 py-2 rounded-bay"
                  style={{ background: "var(--c-field-lift)" }}
                >
                  Yubordik! Direktni oching @dilnoza_s
                </p>
              </div>
              <div className="text-[15px]">
                <p className="util text-saffron/80 mb-1">direkt</p>
                <p
                  className="px-3 py-2 rounded-bay"
                  style={{ background: "var(--c-field-lift)" }}
                >
                  Obuna bo'ling, keyin tugmani bosing.
                </p>
                <span
                  className="util inline-block mt-2 px-2.5 py-1.5 rounded-jack border"
                  style={{ borderColor: "var(--c-signal)", color: "var(--c-signal)" }}
                >
                  Obuna bo'ldim
                </span>
              </div>
              <div className="text-[15px]">
                <p className="util text-saffron/80 mb-1">havola</p>
                <p
                  className="px-3 py-2 rounded-bay"
                  style={{ background: "var(--c-signal)", color: "var(--c-field-deep)" }}
                >
                  Rahmat! Mana havola: kurs.uz/reels-funnel
                </p>
              </div>
            </div>
            <p className="util mt-auto pt-4 text-paper/45">
              boshidan oxirigacha 4.2 s · qo'l tegmadi
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
