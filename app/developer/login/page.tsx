import LogoMark from "@/components/logo-mark";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDeveloperSession, isDeveloperAreaConfigured } from "@/lib/developer/auth";
import { developerLoginAction } from "@/lib/developer/actions";

export const metadata: Metadata = { title: "Kirish" };

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Email yoki parol noto'g'ri.",
  locked: "Juda ko'p urinish. 15 daqiqadan keyin qayta urinib ko'ring.",
};

const inputClass =
  "mt-1 w-full rounded border border-border bg-background px-3 py-2 text-foreground focus:border-accent focus:outline-none";

export default async function DeveloperLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getDeveloperSession()) redirect("/developer");

  const params = await searchParams;
  const errorMessage = params.error ? ERROR_MESSAGES[params.error] : null;
  const configured = isDeveloperAreaConfigured();

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-5 text-foreground">
      <div className="w-full max-w-sm">
        <div className="text-center">
          <span className="inline-flex items-center gap-2.5 font-display text-lg font-extrabold tracking-tight text-foreground">
            <LogoMark />
            SocialAuto
          </span>
          <h1 className="mt-4 font-display text-2xl font-extrabold text-foreground">Developer</h1>
          <p className="mt-2 text-sm text-muted">
            Qurilayotgan modullarni ko’rish va test qilish uchun.
          </p>
        </div>

        {!configured && (
          <p className="mt-6 rounded border border-warning/40 bg-warning/10 p-3 text-center text-sm text-warning">
            Developer bo’limi sozlanmagan: serverda DEVELOPER_EMAIL va DEVELOPER_PASSWORD_HASH
            o’rnatilmagan.
          </p>
        )}
        {errorMessage && (
          <p className="mt-6 rounded border border-error/40 bg-error/10 p-3 text-center text-sm text-error">
            {errorMessage}
          </p>
        )}

        <form action={developerLoginAction} className="mt-6 space-y-4">
          <label className="block text-sm">
            <span className="text-muted">Email</span>
            <input name="email" type="email" autoComplete="username" required className={inputClass} />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Parol</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className={inputClass}
            />
          </label>
          <button
            type="submit"
            disabled={!configured}
            className="label-mono w-full rounded bg-accent px-4 py-2.5 text-xs font-bold text-background transition hover:bg-accent-hover disabled:opacity-50"
          >
            Kirish
          </button>
        </form>
      </div>
    </main>
  );
}
