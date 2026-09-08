"use client";

import { useRef } from "react";
import Link from "next/link";
import { useArrival, useTilt } from "@/components/motion/useActs";
import { Marginalia } from "@/components/ui/Kit";
import Icon from "@/components/ui/Icon";

/* ACT 1 · ARRIVAL — the thesis: a comment enters a jack, a link comes out. */
export default function Hero() {
  const scope = useRef<HTMLElement>(null);
  useArrival(scope);
  useTilt(scope, "[data-tilt]");

  return (
    <section
      ref={scope}
      id="main"
      className="relative grain bleed overflow-hidden"
      style={{ ["--bleed-to" as string]: "var(--c-field-deep)" }}
    >
      {/* background field: three ikat bands, the only ornament up here */}
      <div aria-hidden className="absolute inset-0 pointer-events-none">
        <div
          className="absolute -left-40 top-10 w-[70vw] h-[70vw] rounded-jack opacity-[0.35] blur-[2px]"
          style={{
            background:
              "conic-gradient(from 210deg, var(--c-madder), var(--c-field-lift) 40%, var(--c-field) 70%, var(--c-madder))",
          }}
        />
        <div
          className="absolute inset-x-0 top-0 h-[3px]"
          style={{ background: "var(--c-saffron)" }}
        />
      </div>

      <div className="relative mx-auto max-w-[1320px] px-5 md:px-8 pt-6 pb-24 md:pb-32">
        {/* top rail */}
        <nav className="flex items-center gap-4 pb-16 md:pb-24">
          <span className="util px-2 py-1" style={{ background: "var(--c-paper)", color: "var(--c-field-deep)" }}>
            IGDM
          </span>
          <span className="util hidden sm:inline text-paper/55">
            izoh → direkt · v1.0
          </span>
          <span className="ml-auto flex items-center gap-2 util" style={{ color: "var(--c-wrong)" }}>
            {/* the one "wrong" colour on the page: the live webhook pulse */}
            <span className="w-2 h-2 rounded-jack animate-pulse" style={{ background: "var(--c-wrong)" }} aria-hidden />
            webhook ulangan
          </span>
          <Link href="/login" className="btn btn-ghost">
            Kirish
          </Link>
        </nav>

        <div className="grid lg:grid-cols-[1fr_minmax(0,560px)] gap-10 lg:gap-14 items-end">
          {/* ── type column ── */}
          <div className="relative">
            <div className="flex gap-5">
              <span aria-hidden className="trunk w-[3px] shrink-0 hidden md:block" />
              <div>
                <p className="util text-saffron mb-5" data-arrival="mark">
                  01 · izoh keladi &nbsp;→&nbsp; 02 · ochiq javob &nbsp;→&nbsp; 03 · direkt
                </p>

                <h1 className="display text-[clamp(3rem,9vw,7.4rem)]">
                  <span className="block" data-split>
                    IZOHDAN
                  </span>
                  {/* the single "type as object" moment: this word runs under
                      the 3D plate and is clipped by it */}
                  <span
                    className="block relative z-10"
                    style={{ color: "var(--c-signal)" }}
                  >
                    DIREKTGACHA
                  </span>
                  <span className="block text-[0.42em] mt-3" style={{ color: "var(--c-madder)" }}>
                    4 soniyada, siz uxlayotganingizda
                  </span>
                </h1>

                <p className="mt-7 text-b-1 measure text-paper/85" data-arrival="sub">
                  Reelsingiz ostiga «tizim» deb yozgan odam darhol ochiq javob
                  oladi, so'ng direktga havola tushadi. Qoidalar siznikida:
                  kalit so'z, shart, matn. Sun'iy intellekt yo'q — faqat
                  siz yozgan ssenariy.
                </p>

                <div className="mt-8 flex flex-wrap gap-3" data-arrival="sub">
                  <Link href="/dashboard" className="btn btn-primary">
                    Instagram akkountini ulash
                    <Icon name="arrow" size={16} />
                  </Link>
                  <a href="#kommutator" className="btn btn-ghost">
                    <Icon name="play" size={14} />
                    Ishlashini ko'rish
                  </a>
                </div>

                <div className="mt-10 max-w-[420px]">
                  <Marginalia
                    items={[
                      ["o'rtacha javob", "4.2 s"],
                      ["navbat", "3 ta hodisa"],
                      ["24 soatlik oyna", "ochiq"],
                      ["oylik to'lov", "$0 · ManyChat $29"],
                    ]}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* ── the 3D plate: a fragment of the switchboard ── */}
          <div className="rig" data-arrival="plate">
            <div data-tilt className="relative plate plate-specular rounded-bay p-4 md:p-5">
              <p className="util text-paper/55 mb-3">jonli izoh oqimi</p>

              <div className="space-y-2">
                {[
                  ["dilnoza_s", "Tizimly", "mos keldi"],
                  ["asadbek.dev", "тизим 🔥", "mos keldi"],
                  ["nodira_style", "narxi qancha?", "e'tiborsiz"],
                ].map(([u, t, r], i) => (
                  <div
                    key={u}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-bay"
                    style={{
                      background: "rgba(12,13,63,.6)",
                      border: "1px solid var(--c-line)",
                      transform: `translateZ(${(3 - i) * 14}px)`,
                    }}
                  >
                    <span className="w-7 h-7 rounded-jack shrink-0" style={{ background: i === 2 ? "var(--c-ink-soft)" : "var(--c-madder)" }} aria-hidden />
                    <span className="min-w-0">
                      <span className="util block text-paper/55">@{u}</span>
                      <span className="block truncate">{t}</span>
                    </span>
                    <span
                      className="util ml-auto shrink-0"
                      style={{ color: r === "mos keldi" ? "var(--c-signal)" : "var(--c-paper)", opacity: r === "mos keldi" ? 1 : 0.45 }}
                    >
                      {r}
                    </span>
                  </div>
                ))}
              </div>

              {/* jack row — the switchboard motif that carries the whole site */}
              <div
                className="mt-4 flex items-center gap-3 px-3 py-3 rounded-bay"
                style={{ background: "var(--c-field-deep)", transform: "translateZ(40px)" }}
              >
                {["kalit so'z", "shart", "havola"].map((l, i) => (
                  <span key={l} className="flex items-center gap-2">
                    <span
                      className="w-5 h-5 rounded-jack border-2"
                      style={{
                        borderColor: "var(--c-saffron)",
                        background: i === 0 ? "var(--c-signal)" : "transparent",
                      }}
                      aria-hidden
                    />
                    <span className="util text-paper/60">{l}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
