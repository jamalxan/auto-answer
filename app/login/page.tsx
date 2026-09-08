import { EMAIL_PROVIDER_ID, signIn } from "@/lib/auth";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import LanguageSwitcher from "@/components/language-switcher";

export const metadata = {
  title: "Login - SocialAuto",
  description: "Sign in to manage Instagram comment-to-DM campaigns.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    checkEmail?: string;
    callbackUrl?: string;
    template?: string;
  }>;
}) {
  const params = await searchParams;
  const checkEmail = params.checkEmail === "1";
  const locale = await getServerLocale();
  const t = dictionaries[locale];
  const selectedTemplate = getCampaignTemplate(params.template, locale);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl = params.callbackUrl ?? templateCallbackUrl ?? "/dashboard";

  async function sendMagicLink(formData: FormData) {
    "use server";
    await signIn(EMAIL_PROVIDER_ID, {
      email: String(formData.get("email") ?? ""),
      redirectTo: callbackUrl,
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="mb-3 flex justify-end">
          <LanguageSwitcher />
        </div>
        <div className="text-center mb-8">
          <h1 className="font-display text-2xl font-extrabold text-foreground">
            {t.login.brand}
          </h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            {selectedTemplate
              ? t.login.templateSubtitle(selectedTemplate.title)
              : t.login.subtitle}
          </p>
        </div>

        <div className="panel rounded p-8 shadow-black/40">
          {selectedTemplate && !checkEmail && (
            <div className="mb-5 border border-accent/20 bg-accent/10 p-4">
              <p className="label-mono text-[11px] font-semibold text-accent">
                {t.login.templateSelectedLabel}
              </p>
              <p className="mt-2 text-sm font-semibold text-foreground">
                {selectedTemplate.title}
              </p>
            </div>
          )}

          {checkEmail ? (
            <div className="text-center py-4">
              <h2 className="text-lg font-semibold mb-2">{t.login.checkEmailTitle}</h2>
              <p className="text-sm text-muted">{t.login.checkEmailBody}</p>
            </div>
          ) : (
            <form action={sendMagicLink} className="space-y-5">
              <div className="space-y-2">
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-foreground"
                >
                  {t.login.workEmail}
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder={t.login.emailPlaceholder}
                  className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-muted focus:border-accent/40 focus:outline-none transition-colors"
                />
              </div>

              <button
                type="submit"
                className="label-mono w-full inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-xs font-bold text-background transition-all hover:bg-accent-hover"
              >
                {t.login.submit}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
