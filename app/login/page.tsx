import Link from "next/link";
import { EMAIL_PROVIDER_ID, signIn } from "@/lib/auth";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import LanguageSwitcher from "@/components/language-switcher";
import { Wordmark } from "@/components/logo-mark";
import MarkScene from "@/components/brand/mark-scene";

export const metadata = {
  title: "Login",
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
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* Brand field: the mark assembling itself on Electric Violet. */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-violet px-12 py-10 text-white lg:flex xl:px-16">
        <Link href="/" className="inline-flex" aria-label="SocialAuto">
          <Wordmark tone="violet" markClassName="h-9 w-9" textClassName="text-[1.3rem]" />
        </Link>

        <MarkScene tone="violet" className="my-8 max-w-[24rem]" />

        <div>
          <h2 className="display text-[2.6rem] xl:text-[3.25rem]">{t.login.heroTitle}</h2>
          <p className="mt-5 max-w-md text-lg leading-8 text-white/85">{t.login.heroBody}</p>
        </div>
      </aside>

      <main className="flex min-h-dvh flex-col px-6 py-6 sm:px-10 lg:min-h-0 lg:px-16">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" className="inline-flex lg:hidden" aria-label="SocialAuto">
            <Wordmark markClassName="h-8 w-8" textClassName="text-[1.2rem]" />
          </Link>
          <LanguageSwitcher className="ml-auto" />
        </div>

        <div className="my-auto w-full max-w-md self-center py-12 lg:py-16">
          <h1 className="display text-[2.1rem] sm:text-[2.6rem]">{t.publicSite.signIn}</h1>
          <p className="mt-4 text-lg leading-8 text-cloud/85">
            {selectedTemplate
              ? t.login.templateSubtitle(selectedTemplate.title)
              : t.login.subtitle}
          </p>

          {selectedTemplate && !checkEmail && (
            <div className="mt-8 rounded-2xl bg-surface p-5">
              <p className="text-sm font-semibold text-lime">{t.login.templateSelectedLabel}</p>
              <p className="mt-1.5 text-base font-semibold">{selectedTemplate.title}</p>
            </div>
          )}

          {checkEmail ? (
            <div className="mt-10 rounded-3xl bg-surface p-8">
              <h2 className="display text-[1.5rem]">{t.login.checkEmailTitle}</h2>
              <p className="mt-3 text-base leading-7 text-cloud/85">{t.login.checkEmailBody}</p>
            </div>
          ) : (
            <form action={sendMagicLink} className="mt-10 space-y-5">
              <div className="space-y-2">
                <label htmlFor="email" className="block text-base font-semibold">
                  {t.login.workEmail}
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder={t.login.emailPlaceholder}
                  className="w-full rounded-full bg-surface px-6 py-4 text-base text-white placeholder:text-muted"
                />
              </div>

              <button type="submit" className="btn btn-primary w-full !py-4">
                {t.login.submit}
              </button>

              <p className="text-sm leading-6 text-muted">{t.login.noPassword}</p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
