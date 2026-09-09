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
          <span className="font-display text-lg font-extrabold text-foreground">
            SocialAuto
          </span>
          <h1 className="mt-4 font-display text-2xl font-extrabold text-foreground">
            Yangi parol
          </h1>
        </div>

        {errorMessage && (
          <p className="mt-6 rounded border-2 border-red-500/40 bg-red-500/10 p-3 text-center text-sm text-red-500">
            {errorMessage}
          </p>
        )}

        <form action={action} className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="text-muted">Yangi parol</span>
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1 w-full rounded border-2 border-border bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Yangi parolni takrorlang</span>
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1 w-full rounded border-2 border-border bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="label-mono w-full rounded bg-accent px-4 py-2.5 text-xs font-bold text-background transition hover:bg-accent-hover"
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
