import LogoMark from "@/components/logo-mark";
import type { Metadata } from "next";
import Link from "next/link";
import { adminResetPasswordAction } from "@/lib/admin/auth-actions";

export const metadata: Metadata = {
  title: "Admin — Reset Password",
  robots: { index: false, follow: false },
};

const ERROR_MESSAGES: Record<string, string> = {
  too_short: "Parol kamida 8 belgidan iborat bo'lishi kerak.",
  mismatch: "Parollar mos kelmadi.",
  invalid_token: "Havola yaroqsiz yoki muddati o'tgan. Qaytadan so'rang.",
};

export default async function AdminResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const errorMessage = error ? ERROR_MESSAGES[error] : null;

  const action = adminResetPasswordAction.bind(null, token);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 text-foreground">
      <div className="w-full max-w-sm">
        <div className="text-center">
          <span className="inline-flex items-center gap-2.5 font-display text-lg font-extrabold tracking-tight text-white">
            <LogoMark />
            SocialAuto
          </span>
          <h1 className="display mt-6 text-[1.75rem] text-white">
            Yangi parol
          </h1>
        </div>

        {errorMessage && (
          <p className="mt-6 rounded-2xl bg-error/12 px-4 py-3 text-center text-sm text-error">
            {errorMessage}
          </p>
        )}

        <form action={action} className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="font-medium text-cloud/85">Yangi parol</span>
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="input mt-1.5 !bg-surface"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-cloud/85">Yangi parolni takrorlang</span>
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="input mt-1.5 !bg-surface"
            />
          </label>
          <button
            type="submit"
            className="btn btn-lime w-full"
          >
            Parolni saqlash
          </button>
        </form>

        <p className="mt-4 text-center text-sm">
          <Link href="/admin/login" className="text-muted hover:text-foreground">
            Kirishga qaytish
          </Link>
        </p>
      </div>
    </main>
  );
}
