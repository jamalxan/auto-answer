import Link from "next/link";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";

export const metadata = {
  title: "Check your email",
  description: "A sign-in link was sent to your email.",
};

export default async function VerifyRequestPage() {
  const locale = await getServerLocale();
  const t = dictionaries[locale];

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="font-display text-2xl font-extrabold text-foreground">
            {t.login.brand}
          </h1>
        </div>

        <div className="panel rounded p-8 text-center">
          <h2 className="text-lg font-semibold mb-2">{t.login.checkEmailTitle}</h2>
          <p className="text-sm text-muted">{t.login.checkEmailBody}</p>
          <p className="mt-6 text-sm">
            <Link href="/login" className="text-accent hover:underline">
              {t.login.backToSignIn}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
