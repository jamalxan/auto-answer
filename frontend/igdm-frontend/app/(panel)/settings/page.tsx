"use client";

import { useRef, useState } from "react";
import Shell from "@/components/panel/Shell";
import { Bay, Field, Toggle } from "@/components/ui/Kit";
import { usePanelEntrance } from "@/components/motion/useActs";

export default function SettingsPage() {
  const scope = useRef<HTMLDivElement>(null);
  usePanelEntrance(scope);
  const [saved, setSaved] = useState(false);

  return (
    <Shell
      title="Sozlamalar"
      crumb="panel va ogohlantirishlar"
      actions={
        <button className="btn btn-primary" type="button" onClick={() => setSaved(true)}>
          Saqlash
        </button>
      }
    >
      {saved && (
        <p
          role="status"
          className="util mb-4 px-4 py-3 rounded-bay"
          style={{ background: "var(--c-signal)", color: "var(--c-field-deep)" }}
        >
          Saqlandi.
        </p>
      )}

      <div ref={scope} className="grid lg:grid-cols-2 gap-4 items-start">
        <Bay paper label="Umumiy">
          <div className="space-y-4">
            <Field label="Vaqt mintaqasi" htmlFor="tz" hint="Jurnal va hisobotlar shu vaqtda ko'rsatiladi.">
              <select id="tz" className="input" defaultValue="Asia/Tashkent">
                <option>Asia/Tashkent (UTC+5)</option>
                <option>UTC</option>
              </select>
            </Field>
            <Field label="Panel tili" htmlFor="lang">
              <select id="lang" className="input">
                <option>O'zbekcha</option>
                <option>Русский</option>
                <option>English</option>
              </select>
            </Field>
            <Field label="Jurnal saqlanadi" htmlFor="ret" hint="Muddatdan oshgan yozuvlar o'chiriladi.">
              <select id="ret" className="input" defaultValue="12">
                <option value="3">3 oy</option>
                <option value="12">12 oy</option>
                <option value="24">24 oy</option>
              </select>
            </Field>
          </div>
        </Bay>

        <Bay paper label="Ogohlantirishlar">
          <div className="space-y-4">
            <Field label="Xat keladigan pochta" htmlFor="mail">
              <input id="mail" className="input" defaultValue="admin@everest.uz" />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[15px]">Token tugashi yoki uzilishi</span>
              <Toggle id="a1" checked />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[15px]">So'rov chegarasiga urilganda</span>
              <Toggle id="a2" checked />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[15px]">Telegramga ham yuborilsin</span>
              <Toggle id="a3" />
            </div>
            <Field
              label="Xato ulushi qanchada xabar bersin"
              htmlFor="thr"
              hint="Bir soatdagi yetkazilmagan xabarlar ulushi."
            >
              <input id="thr" className="input" defaultValue="10%" />
            </Field>
          </div>
        </Bay>

        <Bay label="Panelga kirish huquqi">
          <p className="text-b-0 text-paper/85 measure">
            Hozir bitta admin bor. Operator qo'shsangiz, u jurnal va lidlarni
            ko'radi, lekin kampaniyalarni o'zgartira olmaydi.
          </p>
          <button className="btn btn-ghost mt-4" type="button">
            Operator qo'shish
          </button>
        </Bay>

        <Bay label="Chegaralar">
          <dl className="util space-y-2 text-paper/60">
            <div className="flex justify-between gap-3">
              <dt>daqiqasiga hodisa</dt>
              <dd className="text-paper/85">100 ta</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>o'rtacha javob vaqti</dt>
              <dd className="text-paper/85">4.2 s · maqsad 30 s</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>navbatdagi hodisalar</dt>
              <dd className="text-paper/85">3 ta</dd>
            </div>
          </dl>
        </Bay>
      </div>
    </Shell>
  );
}
