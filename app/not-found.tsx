import Link from "next/link";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import PublicSiteHeader from "@/components/public-site-header";
import SiteFooter from "@/components/site-footer";

// Next.js renders this for any unmatched route, and wherever code calls
// notFound() (e.g. /admin for a signed-in non-admin) — branded either way,
// instead of the framework's bare default page.
export default async function NotFound() {
  const locale = await getServerLocale();
  const t = dictionaries[locale].notFound;

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <PublicSiteHeader />

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center px-5 py-20 text-center">
        <p className="label-mono text-sm font-bold text-accent">{t.eyebrow}</p>
        <h1 className="mt-3 font-display text-4xl font-extrabold text-foreground sm:text-5xl">
          {t.title}
        </h1>
        <p className="mt-4 max-w-md text-base leading-7 text-muted">{t.body}</p>
        <Link
          href="/"
          className="label-mono mt-8 inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3 text-xs font-bold text-background transition hover:bg-accent-hover"
        >
          {t.cta}
        </Link>
      </div>

      <SiteFooter />
    </main>
  );
}
