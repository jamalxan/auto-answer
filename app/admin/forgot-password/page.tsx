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
          <span className="font-display text-lg font-extrabold text-foreground">
            SocialAuto
          </span>
          <h1 className="mt-4 font-display text-2xl font-extrabold text-foreground">
            Parolni tiklash
          </h1>
          <p className="mt-2 text-sm text-muted">
            {"Admin akkauntga bog'langan emailni kiriting — tiklash havolasi shu yerga yuboriladi."}
          </p>
        </div>

        {params.sent === "1" ? (
          <p className="mt-6 rounded border-2 border-emerald-500/40 bg-emerald-500/10 p-3 text-center text-sm text-emerald-500">
            {"Agar bu email admin akkauntga bog'langan bo'lsa, tiklash havolasi yuborildi. Pochta qutingizni tekshiring (spam papkasini ham)."}
          </p>
        ) : (
          <form action={adminForgotPasswordAction} className="mt-6 space-y-4">
            <label className="block text-sm">
              <span className="text-muted">Email</span>
              <input
                name="email"
                type="email"
                required
                className="mt-1 w-full rounded border-2 border-border bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none"
              />
            </label>
            <button
              type="submit"
              className="label-mono w-full rounded bg-accent px-4 py-2.5 text-xs font-bold text-background transition hover:bg-accent-hover"
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
