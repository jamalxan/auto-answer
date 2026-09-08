import Link from "next/link";

export const metadata = { title: "Ma'lumotni o'chirish — IGDM" };

export default function DataDeletionPage() {
  return (
    <div className="min-h-svh p-6 lg:p-16" style={{ background: "var(--c-field)", color: "var(--c-paper)" }}>
      <div className="max-w-[720px] mx-auto space-y-6">
        <Link href="/" className="util px-2 py-1 inline-block" style={{ background: "var(--c-paper)", color: "var(--c-field-deep)" }}>
          IGDM
        </Link>
        <h1 className="display text-d-2">Ma&apos;lumotni o&apos;chirish</h1>

        <p>
          Instagram akkountingizni va u bilan bog&apos;liq barcha ma&apos;lumotlarni
          (access token, kampaniyalar, izohlar va xabarlar jurnali) IGDM
          tizimidan o&apos;chirishning ikki yo&apos;li bor:
        </p>

        <h2 className="display text-d-1 mt-8">1. Panel orqali (tezkor)</h2>
        <p>
          Admin panelga kiring →{" "}
          <span style={{ color: "var(--c-saffron)" }}>Akkountlar</span> →
          akkountingiz yonidagi <strong>&quot;Uzish&quot;</strong> tugmasini bosing.
          Bu akkountni darhol uzadi va Meta webhook obunasini bekor qiladi.
        </p>

        <h2 className="display text-d-1 mt-8">2. To&apos;liq o&apos;chirishni so&apos;rash</h2>
        <p>
          Barcha ma&apos;lumotlaringizni (jurnal tarixi bilan birga) butunlay
          o&apos;chirishni xohlasangiz, quyidagi manzilga Instagram
          foydalanuvchi nomingiz bilan yozing:{" "}
          <a className="underline" href="mailto:jamolxonyoldashaliyev3@gmail.com">
            jamolxonyoldashaliyev3@gmail.com
          </a>
          . So&apos;rov 30 kun ichida bajariladi.
        </p>
      </div>
    </div>
  );
}
