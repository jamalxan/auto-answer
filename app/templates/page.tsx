import type { Metadata } from "next";
import Link from "next/link";
import PublicSiteHeader from "@/components/public-site-header";
import TemplateVisual from "@/components/template-visual";
import { CAMPAIGN_TEMPLATES } from "@/lib/templates/campaign-templates";

export const metadata: Metadata = {
  title: "Instagram Comment to DM Templates - SocialAuto",
  description:
    "Copy ready-to-launch Instagram comment-to-DM campaign templates for product links, lead magnets, real estate, fitness, restaurants, events, and creators.",
  keywords: [
    "Instagram comment to DM templates",
    "comment to DM campaigns",
    "Instagram DM automation templates",
    "Manychat alternative templates",
  ],
};

export default function TemplatesPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicSiteHeader active="templates" />

      <section className="border-b-2 border-border bg-surface">
        <div className="mx-auto grid w-full max-w-7xl gap-10 px-5 py-16 sm:px-6 lg:grid-cols-[0.88fr_1.12fr] lg:px-8 lg:py-20">
          <div>
            <p className="label-mono text-sm font-bold text-accent">
              Public template library
            </p>
            <h1 className="mt-4 font-display text-5xl font-extrabold leading-[1.02] text-foreground sm:text-6xl">
              Instagram campaigns you can copy in minutes
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
              Start with proven comment-to-DM playbooks for lead magnets,
              product links, events, service menus, and agency client campaigns.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/login"
                className="label-mono inline-flex items-center justify-center rounded bg-accent px-6 py-3 text-xs font-bold text-background transition hover:bg-accent-hover"
              >
                Start free
              </Link>
              <a
                href="#template-grid"
                className="label-mono inline-flex items-center justify-center rounded border-2 border-border bg-transparent px-6 py-3 text-xs font-bold text-foreground transition hover:border-border-hover hover:bg-surface-hover"
              >
                Browse templates
              </a>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {CAMPAIGN_TEMPLATES.slice(0, 2).map((template) => (
              <TemplateVisual key={template.slug} template={template} compact />
            ))}
          </div>
        </div>
      </section>

      <section
        id="template-grid"
        className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-6 lg:px-8"
      >
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {CAMPAIGN_TEMPLATES.map((template) => (
            <article
              key={template.slug}
              className="panel flex min-h-full flex-col rounded p-5 transition hover:border-accent/40"
            >
              <div className="mb-5">
                <TemplateVisual template={template} compact />
              </div>
              <p className="label-mono text-[11px] font-semibold text-accent">
                {template.category}
              </p>
              <h2 className="mt-3 text-xl font-black leading-tight text-foreground">
                {template.title}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted">
                {template.summary}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {template.keywords.map((keyword) => (
                  <span
                    key={keyword}
                    className="rounded border border-border bg-background px-2 py-1 text-xs font-semibold text-muted"
                  >
                    {keyword}
                  </span>
                ))}
              </div>
              <div className="mt-auto grid gap-2 pt-6">
                <Link
                  href={`/templates/${template.slug}`}
                  className="label-mono inline-flex w-full items-center justify-center rounded border-2 border-border bg-transparent px-4 py-3 text-xs font-bold text-foreground transition hover:border-border-hover hover:bg-surface-hover"
                >
                  View playbook
                </Link>
                <Link
                  href={`/login?template=${template.slug}`}
                  className="label-mono inline-flex w-full items-center justify-center rounded bg-accent px-4 py-3 text-xs font-bold text-background transition hover:bg-accent-hover"
                >
                  Use this template
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
