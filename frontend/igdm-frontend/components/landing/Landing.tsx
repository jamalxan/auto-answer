"use client";

import { useRef } from "react";
import Link from "next/link";
import { useQuiet } from "@/components/motion/useActs";
import Icon from "@/components/ui/Icon";

/* ACT 5 · LANDING — everything stops. Only the CTA breathes. */
export default function LandingAct() {
  const scope = useRef<HTMLElement>(null);
  useQuiet(scope);

  return (
    <footer
      ref={scope}
      className="relative grain py-24 md:py-32"
      style={{ background: "var(--c-field-deep)" }}
    >
      <div className="mx-auto max-w-[1320px] px-5 md:px-8">
        <div data-quiet className="max-w-[760px]">
          <p className="util text-saffron">ulanish uch qadam</p>
          <h2 className="display text-[clamp(2.2rem,6vw,4.4rem)] mt-3">
            Akkountni ulang, kalit so'zni yozing, Reels joylang.
          </h2>
          <p className="mt-5 text-b-1 text-paper/80 measure">
            Instagram Business yoki Creator akkounti kerak. Ulangandan keyin
            birinchi kampaniyani sozlash — besh daqiqa.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/dashboard" data-quiet="cta" className="btn btn-primary">
              Instagram akkountini ulash
              <Icon name="arrow" size={16} />
            </Link>
            <Link href="/login" className="btn btn-ghost">
              Panelga kirish
            </Link>
          </div>
        </div>

        <div className="mt-20 pt-6 border-t border-line grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div>
            <p className="util text-paper/45 mb-2">Mahsulot</p>
            <ul className="space-y-1.5 text-[15px] text-paper/80">
              <li><Link href="/dashboard" className="hover:text-signal">Panel</Link></li>
              <li><Link href="/campaigns" className="hover:text-signal">Kampaniyalar</Link></li>
              <li><Link href="/logs" className="hover:text-signal">Jurnal</Link></li>
            </ul>
          </div>
          <div>
            <p className="util text-paper/45 mb-2">Qoidalar</p>
            <ul className="space-y-1.5 text-[15px] text-paper/80">
              <li>Sovuq xabar yubormaymiz</li>
              <li>Faqat izoh yozgan odamga</li>
              <li>Meta javob oynasi ichida</li>
            </ul>
          </div>
          <div>
            <p className="util text-paper/45 mb-2">Til</p>
            <ul className="space-y-1.5 text-[15px] text-paper/80">
              <li>O'zbekcha · Русский · English</li>
            </ul>
          </div>
          <div>
            <p className="util text-paper/45 mb-2">Holat</p>
            <p className="util" style={{ color: "var(--c-signal)" }}>
              webhook faol · navbat 3
            </p>
            <p className="mt-3 util text-paper/45">© 2026 IGDM · Toshkent</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
