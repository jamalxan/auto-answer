import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/admin/auth";
import { adminLoginAction } from "@/lib/admin/auth-actions";

export const metadata: Metadata = {
  title: "Admin Login",
  robots: { index: false, follow: false },
};

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Noto'g'ri login yoki parol.",
};

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; reset?: string }>;
}) {
  const session = await getAdminSession();
  if (session) {
    redirect("/admin");
  }

  const params = await searchParams;
  const errorMessage = params.error ? ERROR_MESSAGES[params.error] : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 text-foreground">
      <div className="w-full max-w-sm">
        <div className="text-center">
          <span className="font-display text-lg font-extrabold text-foreground">
            SocialAuto
          </span>
          <h1 className="mt-4 font-display text-2xl font-extrabold text-foreground">
            Admin panel
          </h1>
        </div>

        {params.reset === "1" && (
          <p className="mt-6 rounded border-2 border-emerald-500/40 bg-emerald-500/10 p-3 text-center text-sm text-emerald-500">
            Parol yangilandi. Endi tizimga kiring.
          </p>
        )}
        {errorMessage && (
          <p className="mt-6 rounded border-2 border-red-500/40 bg-red-500/10 p-3 text-center text-sm text-red-500">
            {errorMessage}
          </p>
        )}

        <form action={adminLoginAction} className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="text-muted">Login</span>
            <input
              name="username"
              autoComplete="username"
              required
              className="mt-1 w-full rounded border-2 border-border bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Parol</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded border-2 border-border bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="label-mono w-full rounded bg-accent px-4 py-2.5 text-xs font-bold text-background transition hover:bg-accent-hover"
          >
            Kirish
          </button>
        </form>

        <p className="mt-4 text-center text-sm">
          <Link href="/admin/forgot-password" className="text-muted hover:text-foreground">
            Parolni unutdingizmi?
          </Link>
        </p>
      </div>
    </main>
  );
}
