import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";

export const metadata: Metadata = {
  title: "Terms of Service - SocialAuto",
  description:
    "Terms for using SocialAuto's Instagram comment-to-DM campaign software.",
};

export default async function TermsPage() {
  const locale = await getServerLocale();
  const t = dictionaries[locale].legal.terms;

  return (
    <LegalShell title={t.title} description={t.description} updatedAt="May 24, 2026">
      <section>
        <h2 className="text-xl font-bold text-white">{t.authorizedUseTitle}</h2>
        <p className="mt-3">{t.authorizedUseBody}</p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">{t.complianceTitle}</h2>
        <p className="mt-3">{t.complianceBody}</p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">{t.availabilityTitle}</h2>
        <p className="mt-3">{t.availabilityBody}</p>
      </section>
    </LegalShell>
  );
}
