import type { Metadata } from "next";
import { adminChangePasswordAction } from "@/lib/admin/auth-actions";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import { adminCopy } from "@/lib/admin/copy";
import { AdminTitle, Panel } from "@/components/admin/parts";

export const metadata: Metadata = {
  title: "Settings - Admin",
  robots: { index: false, follow: false },
};

export default async function AdminSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const [locale, params] = await Promise.all([getServerLocale(), searchParams]);
  const t = dictionaries[locale].admin;
  const c = adminCopy(locale);

  const errorMessages: Record<string, string> = {
    too_short: t.settingsErrorTooShort,
    mismatch: t.settingsErrorMismatch,
    wrong_current: t.settingsErrorWrongCurrent,
  };
  const errorMessage = params.error ? errorMessages[params.error] : null;

  return (
    <div className="space-y-6">
      <AdminTitle title={c.settingsTitle} sub={c.settingsSub} />

      <Panel title={c.passwordTitle} sub={c.passwordHint} className="max-w-xl">
        {params.success === "1" && <p className="mb-4 rounded-2xl bg-lime/12 px-4 py-3 text-sm text-lime">{t.settingsSuccess}</p>}
        {errorMessage && <p className="mb-4 rounded-2xl bg-error/12 px-4 py-3 text-sm text-error">{errorMessage}</p>}

        <form action={adminChangePasswordAction} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-cloud/85">{t.settingsCurrentPassword}</span>
            <input name="currentPassword" type="password" autoComplete="current-password" required className="input mt-1.5" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-cloud/85">{t.settingsNewPassword}</span>
            <input name="newPassword" type="password" autoComplete="new-password" required minLength={8} className="input mt-1.5" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-cloud/85">{t.settingsConfirmPassword}</span>
            <input name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} className="input mt-1.5" />
          </label>
          <button type="submit" className="btn btn-sm btn-primary">
            {t.settingsSave}
          </button>
        </form>
      </Panel>
    </div>
  );
}
