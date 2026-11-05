import LogoMark from "@/components/logo-mark";
import type { Metadata } from "next";
import Link from "next/link";
import { adminForgotPasswordAction } from "@/lib/admin/auth-actions";

export const metadata: Metadata = {
  title: "Admin — Forgot Password",
  robots: { index: false, follow: false },
};

export default async function AdminForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 text-foreground">
      <div className="w-full max-w-sm">
        <div className="text-center">
          <span className="inline-flex items-center gap-2.5 font-display text-lg font-extrabold tracking-tight text-white">
            <LogoMark />
            SocialAuto
          </span>
          <h1 className="display mt-6 text-[1.75rem] text-white">
            Parolni tiklash
          </h1>
          <p className="mt-2 text-sm text-muted">
            {"Admin akkauntga bog'langan emailni kiriting — tiklash havolasi shu yerga yuboriladi."}
          </p>
        </div>

        {params.sent === "1" ? (
          <p className="mt-6 rounded-2xl bg-lime/12 px-4 py-3 text-center text-sm text-lime">
            {"Agar bu email admin akkauntga bog'langan bo'lsa, tiklash havolasi yuborildi. Pochta qutingizni tekshiring (spam papkasini ham)."}
          </p>
        ) : (
          <form action={adminForgotPasswordAction} className="mt-6 space-y-4">
            <label className="block text-sm">
              <span className="font-medium text-cloud/85">Email</span>
              <input
                name="email"
                type="email"
                required
                className="input mt-1.5 !bg-surface"
              />
            </label>
            <button
              type="submit"
              className="btn btn-lime w-full"
            >
              Havola yuborish
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-sm">
          <Link href="/admin/login" className="text-muted hover:text-foreground">
            Kirishga qaytish
          </Link>
        </p>
      </div>
    </main>
  );
}
