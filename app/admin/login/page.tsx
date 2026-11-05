import LogoMark from "@/components/logo-mark";
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
  locked: "Juda ko'p urinish. 15 daqiqadan keyin qayta urinib ko'ring.",
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
          <span className="inline-flex items-center gap-2.5 font-display text-lg font-extrabold tracking-tight text-white">
            <LogoMark />
            SocialAuto
          </span>
          <h1 className="display mt-6 text-[1.75rem] text-white">
            Admin panel
          </h1>
        </div>

        {params.reset === "1" && (
          <p className="mt-6 rounded-2xl bg-lime/12 px-4 py-3 text-center text-sm text-lime">
            Parol yangilandi. Endi tizimga kiring.
          </p>
        )}
        {errorMessage && (
          <p className="mt-6 rounded-2xl bg-error/12 px-4 py-3 text-center text-sm text-error">
            {errorMessage}
          </p>
        )}

        <form action={adminLoginAction} className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="font-medium text-cloud/85">Login yoki email</span>
            <input
              name="username"
              autoComplete="username"
              required
              className="input mt-1.5 !bg-surface"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-cloud/85">Parol</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="input mt-1.5 !bg-surface"
            />
          </label>
          <button
            type="submit"
            className="btn btn-lime w-full"
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
