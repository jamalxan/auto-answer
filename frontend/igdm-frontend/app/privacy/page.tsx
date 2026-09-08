import Link from "next/link";

export const metadata = { title: "Maxfiylik siyosati — IGDM" };

export default function PrivacyPage() {
  return (
    <div className="min-h-svh p-6 lg:p-16" style={{ background: "var(--c-field)", color: "var(--c-paper)" }}>
      <div className="max-w-[720px] mx-auto space-y-6">
        <Link href="/" className="util px-2 py-1 inline-block" style={{ background: "var(--c-paper)", color: "var(--c-field-deep)" }}>
          IGDM
        </Link>
        <h1 className="display text-d-2">Maxfiylik siyosati</h1>
        <p className="text-paper/75">Oxirgi yangilanish: 2026-08-14</p>

        <p>
          IGDM (&quot;biz&quot;) Instagram Business akkountlar uchun avtomatik izoh va
          direkt xabar yuborish xizmatini taqdim etadi. Ushbu sahifa xizmatimiz
          orqali qanday ma&apos;lumot yig&apos;ilishi, ishlatilishi va saqlanishini tushuntiradi.
        </p>

        <h2 className="display text-d-1 mt-8">Qanday ma&apos;lumot yig&apos;amiz</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Instagram Business/Creator akkountingizning ID, foydalanuvchi nomi va profil turi.</li>
          <li>Meta tomonidan berilgan OAuth access token (shifrlangan holda saqlanadi).</li>
          <li>Sizning kampaniyalaringiz orqali kelgan izohlar, xabarlar va ularga bergan javoblar jurnali.</li>
          <li>Admin panelga kirish uchun email manzilingiz va parol hashi.</li>
        </ul>

        <h2 className="display text-d-1 mt-8">Ma&apos;lumotdan qanday foydalanamiz</h2>
        <p>
          Yig&apos;ilgan ma&apos;lumot faqat siz sozlagan kampaniyalar asosida izohlarga
          ommaviy javob berish va foydalanuvchilarga direkt xabar (DM) yuborish
          uchun ishlatiladi. Ma&apos;lumotni uchinchi tomonlarga sotmaymiz.
        </p>

        <h2 className="display text-d-1 mt-8">Ma&apos;lumotni saqlash va o&apos;chirish</h2>
        <p>
          Instagram access token&apos;lar shifrlangan holda saqlanadi. Akkountingizni
          panel orqali istalgan vaqtda uzishingiz mumkin — bu holda webhook
          obunasi bekor qilinadi. Ma&apos;lumotlaringizni butunlay o&apos;chirishni
          so&apos;rash uchun{" "}
          <Link href="/data-deletion" className="underline">
            ma&apos;lumotni o&apos;chirish sahifasi
          </Link>
          ga qarang.
        </p>

        <h2 className="display text-d-1 mt-8">Bog&apos;lanish</h2>
        <p>
          Savollar bo&apos;lsa: <a className="underline" href="mailto:jamolxonyoldashaliyev3@gmail.com">jamolxonyoldashaliyev3@gmail.com</a>
        </p>
      </div>
    </div>
  );
}
