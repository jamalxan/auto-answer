import Link from "next/link";

export const metadata = { title: "Foydalanish shartlari — IGDM" };

export default function TermsPage() {
  return (
    <div className="min-h-svh p-6 lg:p-16" style={{ background: "var(--c-field)", color: "var(--c-paper)" }}>
      <div className="max-w-[720px] mx-auto space-y-6">
        <Link href="/" className="util px-2 py-1 inline-block" style={{ background: "var(--c-paper)", color: "var(--c-field-deep)" }}>
          IGDM
        </Link>
        <h1 className="display text-d-2">Foydalanish shartlari</h1>
        <p className="text-paper/75">Oxirgi yangilanish: 2026-08-14</p>

        <p>
          IGDM xizmatidan foydalanish orqali siz quyidagi shartlarga rozilik
          bildirasiz.
        </p>

        <h2 className="display text-d-1 mt-8">Xizmat tavsifi</h2>
        <p>
          IGDM Instagram Business akkountingizga kelgan izohlarga avtomatik
          ommaviy javob berish va shartlarga mos foydalanuvchilarga direkt
          xabar (DM) yuborish imkonini beradi. Xizmat Meta Platform
          Terms va Instagram API foydalanish qoidalariga muvofiq ishlaydi.
        </p>

        <h2 className="display text-d-1 mt-8">Sizning javobgarligingiz</h2>
        <ul className="list-disc pl-6 space-y-1">
          <li>Faqat o&apos;zingizga tegishli yoki boshqarish huquqingiz bo&apos;lgan Instagram akkountni ulashingiz kerak.</li>
          <li>Kampaniya matnlari va havolalari Instagram va O&apos;zbekiston qonunchiligiga zid bo&apos;lmasligi kerak.</li>
          <li>Spam yoki noqonuniy kontent tarqatish uchun xizmatdan foydalanish taqiqlanadi.</li>
        </ul>

        <h2 className="display text-d-1 mt-8">Xizmatni to&apos;xtatish</h2>
        <p>
          Akkountingizni istalgan vaqtda panel orqali uzishingiz mumkin.
          Shartlarni buzgan holatlarda xizmat ko&apos;rsatishni to&apos;xtatish
          huquqini saqlab qolamiz.
        </p>

        <h2 className="display text-d-1 mt-8">Bog&apos;lanish</h2>
        <p>
          Savollar bo&apos;lsa: <a className="underline" href="mailto:jamolxonyoldashaliyev3@gmail.com">jamolxonyoldashaliyev3@gmail.com</a>
        </p>
      </div>
    </div>
  );
}
