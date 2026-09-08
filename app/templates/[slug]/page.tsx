import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import PublicSiteHeader from "@/components/public-site-header";
import TemplateVisual from "@/components/template-visual";
import {
  getCampaignTemplate,
  getCampaignTemplates,
  getCampaignTemplateSlugs,
} from "@/lib/templates/campaign-templates";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";

type TemplatePageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return getCampaignTemplateSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: TemplatePageProps): Promise<Metadata> {
  const { slug } = await params;
  const locale = await getServerLocale();
  const template = getCampaignTemplate(slug, locale);

  if (!template) {
    return {
      title: "Template Not Found - SocialAuto",
    };
  }

  return {
    title: `${template.title} - Instagram Comment to DM Template`,
    description: template.summary,
    keywords: [
      `${template.title} template`,
      "Instagram comment to DM template",
      "Instagram DM campaign template",
      template.category,
      template.audience,
    ],
  };
}

export default async function TemplateDetailPage({ params }: TemplatePageProps) {
  const { slug } = await params;
  const locale = await getServerLocale();
  const t = dictionaries[locale];
  const template = getCampaignTemplate(slug, locale);

  if (!template) {
    notFound();
  }

  const relatedTemplates = getCampaignTemplates(locale)
    .filter((item) => item.slug !== template.slug)
    .slice(0, 3);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicSiteHeader active="templates" />

      <section className="border-b-2 border-border bg-surface">
        <div className="mx-auto grid w-full max-w-7xl gap-10 px-5 py-14 sm:px-6 lg:grid-cols-[0.9fr_1.1fr] lg:px-8 lg:py-20">
          <div>
            <Link
              href="/templates"
              className="text-sm font-semibold text-muted transition hover:text-foreground"
            >
              {t.templateDetail.backToTemplates}
            </Link>
            <p className="label-mono mt-8 text-sm font-bold text-accent">
              {t.templateDetail.categoryTemplateSuffix(template.category)}
            </p>
            <h1 className="mt-4 font-display text-5xl font-extrabold leading-[1.02] text-foreground sm:text-6xl">
              {template.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
              {template.summary}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href={`/login?template=${template.slug}`}
                className="label-mono inline-flex items-center justify-center rounded bg-accent px-6 py-3 text-xs font-bold text-background transition hover:bg-accent-hover"
              >
                {t.templateDetail.useThisTemplate}
              </Link>
              <a
                href="#playbook"
                className="label-mono inline-flex items-center justify-center rounded border-2 border-border bg-transparent px-6 py-3 text-xs font-bold text-foreground transition hover:border-border-hover hover:bg-surface-hover"
              >
                {t.templateDetail.readPlaybook}
              </a>
            </div>
          </div>

          <TemplateVisual template={template} />
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-8 px-5 py-16 sm:px-6 lg:grid-cols-[0.78fr_1.22fr] lg:px-8">
        <aside className="space-y-4">
          <div className="panel rounded p-5">
            <p className="label-mono text-[11px] font-semibold text-muted">
              {t.templateDetail.audienceLabel}
            </p>
            <p className="mt-2 text-lg font-bold text-foreground">{template.audience}</p>
          </div>
          <div className="panel rounded p-5">
            <p className="label-mono text-[11px] font-semibold text-muted">
              {t.templateDetail.setupTimeLabel}
            </p>
            <p className="mt-2 text-lg font-bold text-foreground">
              {t.templateDetail.setupMinutesValue(template.setupMinutes)}
            </p>
          </div>
          <div className="panel rounded p-5">
            <p className="label-mono text-[11px] font-semibold text-muted">
              {t.templateDetail.goalLabel}
            </p>
            <p className="mt-2 text-lg font-bold text-foreground">{template.goal}</p>
          </div>
        </aside>

        <div id="playbook" className="space-y-8">
          <section className="panel rounded p-6">
            <h2 className="font-display text-2xl font-extrabold text-foreground">
              {t.templateDetail.outcomeTitle}
            </h2>
            <p className="mt-3 text-base leading-8 text-muted">
              {template.outcome}
            </p>
          </section>

          <section className="panel rounded p-6">
            <h2 className="font-display text-2xl font-extrabold text-foreground">
              {t.templateDetail.playbookTitle}
            </h2>
            <ol className="mt-5 space-y-3">
              {template.playbook.map((step, index) => (
                <li key={step} className="grid gap-3 sm:grid-cols-[40px_1fr]">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-black text-background">
                    {index + 1}
                  </span>
                  <span className="text-sm leading-7 text-muted">{step}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="panel rounded p-6">
              <h2 className="text-xl font-black text-foreground">{t.templateDetail.bestForTitle}</h2>
              <ul className="mt-4 space-y-2">
                {template.bestFor.map((item) => (
                  <li key={item} className="text-sm text-muted">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="panel rounded p-6">
              <h2 className="text-xl font-black text-foreground">{t.templateDetail.metricsTitle}</h2>
              <ul className="mt-4 space-y-2">
                {template.metrics.map((item) => (
                  <li key={item} className="text-sm text-muted">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="rounded border-2 border-accent/30 bg-accent/10 p-6">
            <div className="grid gap-5 lg:grid-cols-[1fr_auto] lg:items-center">
              <div>
                <h2 className="font-display text-2xl font-extrabold text-foreground">
                  {t.templateDetail.copyIntoTitle}
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {t.templateDetail.copyIntoBody}
                </p>
              </div>
              <Link
                href={`/login?template=${template.slug}`}
                className="label-mono inline-flex items-center justify-center rounded bg-accent px-6 py-3 text-xs font-bold text-background transition hover:bg-accent-hover"
              >
                {t.templateDetail.useThisTemplate}
              </Link>
            </div>
          </section>
        </div>
      </section>

      <section className="border-t-2 border-border bg-surface py-14">
        <div className="mx-auto w-full max-w-7xl px-5 sm:px-6 lg:px-8">
          <h2 className="font-display text-2xl font-extrabold text-foreground">
            {t.templateDetail.moreTemplatesTitle}
          </h2>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {relatedTemplates.map((item) => (
              <Link
                key={item.slug}
                href={`/templates/${item.slug}`}
                className="panel rounded p-5 transition hover:border-accent/40"
              >
                <p className="label-mono text-[11px] font-semibold text-accent">
                  {item.category}
                </p>
                <h3 className="mt-3 text-lg font-black text-foreground">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {item.summary}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
