import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";

export const metadata: Metadata = {
  title: "Privacy Policy - SocialAuto",
  description:
    "How SocialAuto handles Instagram account data, webhook payloads, billing data, and customer campaign information.",
};

export default async function PrivacyPage() {
  const locale = await getServerLocale();
  const t = dictionaries[locale].legal.privacy;

  return (
    <LegalShell title={t.title} description={t.description} updatedAt="May 24, 2026">
      <section>
        <h2 className="text-xl font-bold text-white">{t.dataWeCollectTitle}</h2>
        <p className="mt-3">{t.dataWeCollectBody}</p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">{t.howWeUseTitle}</h2>
        <p className="mt-3">{t.howWeUseBody}</p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">{t.instagramMetaTitle}</h2>
        <p className="mt-3">{t.instagramMetaBody}</p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">{t.subprocessorsTitle}</h2>
        <p className="mt-3">{t.subprocessorsBody}</p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">{t.retentionTitle}</h2>
        <p className="mt-3">{t.retentionBody}</p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">{t.contactTitle}</h2>
        <p className="mt-3">{t.contactBody}</p>
      </section>
    </LegalShell>
  );
}
