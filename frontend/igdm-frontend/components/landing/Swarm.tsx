"use client";

import { useRef } from "react";
import { useSwarm } from "@/components/motion/useActs";
import Icon from "@/components/ui/Icon";

type Cell = { t: string; b: string; icon: string; span?: string; hot?: boolean };

const CELLS: Cell[] = [
  {
    t: "Lotin va kirill bir xil",
    b: "«tizim», «Тизим», «TIZIM» — bittasi. Emoji va ortiqcha probel tozalanadi, qidiruv aniq so'z, ichida yoki to'liq mos bo'lishi mumkin.",
    icon: "funnel",
    span: "md:col-span-2",
    hot: true,
  },
  {
    t: "Ochiq javob varianti",
    b: "Bir nechta matn yozing — tizim navbat bilan almashtiradi, izohlar bir xil ko'rinmaydi.",
    icon: "copy",
  },
  {
    t: "To'rt xil shart",
    b: "Shartsiz, o'zi tasdiqlaydi, tashqi bazadan tekshiriladi yoki javob yozishi kifoya.",
    icon: "jack",
  },
  {
    t: "Takror yubormaydi",
    b: "Har bir izoh identifikatori bo'yicha bir marta. Meta hodisani qayta yuborsa ham ikkinchi javob ketmaydi.",
    icon: "check",
  },
  {
    t: "Sovuq xabar yo'q",
    b: "Har bir direkt odamning o'z izohidan boshlanadi. Meta qoidalari va javob oynasi hurmat qilinadi.",
    icon: "clock",
    span: "md:col-span-2",
  },
  {
    t: "Jurnal va eksport",
    b: "Har bir izoh, javob, xato kodi joyida. Lidlarni CSV qilib yuklab oling.",
    icon: "log",
  },
  {
    t: "Test rejimi",
    b: "To'liq oqimni o'z akkountingizda, hech narsani omma oldida chop etmasdan sinab ko'ring.",
    icon: "play",
  },
  {
    t: "Token tugasa xabar beradi",
    b: "Ulanish uzilsa yoki chegaraga urilsa, pochtaga xat keladi va panelda qayta ulash tugmasi chiqadi.",
    icon: "alert",
  },
];

/* ACT 4 · SWARM — the capability field arrives as one wave from the centre. */
export default function Swarm() {
  const scope = useRef<HTMLElement>(null);
  useSwarm(scope);

  return (
    <section
      ref={scope}
      className="relative grain bleed py-24 md:py-32"
      style={{ ["--bleed-to" as string]: "var(--c-field-deep)" }}
    >
      <div className="mx-auto max-w-[1320px] px-5 md:px-8">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3 mb-10">
          <h2 className="display text-[clamp(2rem,5vw,3.8rem)]">Panel nimani boshqaradi</h2>
          <p className="util text-saffron">8 ta blok · barchasi panelda, kodsiz</p>
        </div>

        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
          {CELLS.map((c) => (
            <article
              key={c.t}
              className={`grid-item plate rounded-bay p-5 flex flex-col gap-2.5 ${c.span ?? ""}`}
              style={
                c.hot
                  ? { background: "var(--c-field-lift)", borderColor: "var(--c-signal)" }
                  : undefined
              }
            >
              <Icon
                name={c.icon}
                size={22}
                style={{ color: c.hot ? "var(--c-signal)" : "var(--c-saffron)" }}
              />
              <h3 className="font-display text-b-1 leading-tight">{c.t}</h3>
              <p className="text-[15px] leading-relaxed text-paper/80">{c.b}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
