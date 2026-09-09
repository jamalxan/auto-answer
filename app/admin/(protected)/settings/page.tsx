import type { Metadata } from "next";
import { adminChangePasswordAction } from "@/lib/admin/auth-actions";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";

export const metadata: Metadata = {
  title: "Settings - Admin",
  robots: { index: false, follow: false },
};

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const [locale, params] = await Promise.all([getServerLocale(), searchParams]);
  const t = dictionaries[locale].admin;

  const errorMessages: Record<string, string> = {
    too_short: t.settingsErrorTooShort,
    mismatch: t.settingsErrorMismatch,
    wrong_current: t.settingsErrorWrongCurrent,
  };
  const errorMessage = params.error ? errorMessages[params.error] : null;

  return (
    <section className="panel max-w-lg rounded p-4 sm:p-6">
      <h1 className="font-display text-xl font-extrabold text-foreground">{t.settingsTitle}</h1>

      <div className="mt-6 rounded border-2 border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">{t.settingsChangePassword}</h2>

        {params.success === "1" && (
          <p className="mt-3 rounded border-2 border-emerald-500/40 bg-emerald-500/10 p-2.5 text-sm text-emerald-500">
            {t.settingsSuccess}
          </p>
        )}
        {errorMessage && (
          <p className="mt-3 rounded border-2 border-red-500/40 bg-red-500/10 p-2.5 text-sm text-red-500">
            {errorMessage}
          </p>
        )}

        <form action={adminChangePasswordAction} className="mt-4 space-y-3">
          <label className="block text-xs text-muted">
            {t.settingsCurrentPassword}
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          <label className="block text-xs text-muted">
            {t.settingsNewPassword}
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          <label className="block text-xs text-muted">
            {t.settingsConfirmPassword}
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
            />
          </label>
          <button
            type="submit"
            className="label-mono rounded bg-accent px-4 py-1.5 text-xs font-bold text-background transition hover:bg-accent-hover"
          >
            {t.settingsSave}
          </button>
        </form>
      </div>
    </section>
  );
}
