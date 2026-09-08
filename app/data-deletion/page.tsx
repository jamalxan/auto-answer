import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";

export const metadata: Metadata = {
  title: "Data Deletion",
  description:
    "How SocialAuto customers can disconnect Instagram and request account or campaign data deletion.",
};

export default async function DataDeletionPage() {
  const locale = await getServerLocale();
  const t = dictionaries[locale].legal.dataDeletion;

  return (
    <LegalShell title={t.title} description={t.description} updatedAt="May 24, 2026">
      <section>
        <h2 className="text-xl font-bold text-white">{t.disconnectTitle}</h2>
        <p className="mt-3">{t.disconnectBody}</p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">{t.deleteWorkspaceTitle}</h2>
        <p className="mt-3">{t.deleteWorkspaceBody}</p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">{t.verificationTitle}</h2>
        <p className="mt-3">{t.verificationBody}</p>
      </section>
    </LegalShell>
  );
}
