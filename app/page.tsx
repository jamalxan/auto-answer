import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import type { Dictionary } from "@/lib/i18n/dictionary";
import PublicSiteHeader from "@/components/public-site-header";
import SiteFooter from "@/components/site-footer";
import HeroDemo from "@/components/brand/hero-demo";
import Reveal from "@/components/brand/reveal";
import Tilt from "@/components/brand/tilt";
import { CommentSolid, DmSolid, TriggerSolid } from "@/components/brand/shapes";
import { Wordmark } from "@/components/logo-mark";
import { getActivePricingPlans, getDefaultPricingPlans } from "@/lib/pricing";

export const metadata: Metadata = {
  title: { absolute: "SocialAuto - Instagram comment-to-DM automation" },
  description:
    "Turn Instagram keyword comments into automatic private replies using the official Meta API.",
  alternates: { canonical: "/" },
};

// Minimal, honest JSON-LD: no aggregateRating/review — there's no review
// data behind those fields, and a fabricated one is a Google spam violation.
const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "SocialAuto",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  url: "https://socialauto.uz",
  description:
    "Turn Instagram keyword comments into automatic private replies using the official Meta API.",
};

function Container({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`mx-auto w-full max-w-7xl px-5 sm:px-8 ${className}`}>{children}</div>;
}

/* Section heading scale: one display size for every chapter. */
const h2 = "display text-[2rem] sm:text-[2.75rem] lg:text-[3.4rem]";
const h3 = "display text-[1.7rem] sm:text-[2.1rem] lg:text-[2.4rem]";

/* A faithful, static copy of the real Dashboard screen in the app's own
   tokens, so what visitors see is what the app looks like. */

const dashboardChart: [string, number][] = [
  ["Mon", 42],
  ["Tue", 68],
  ["Wed", 51],
  ["Thu", 94],
  ["Fri", 120],
  ["Sat", 86],
  ["Sun", 73],
];

function DashboardPreview({ t, username }: { t: Dictionary; username: string }) {
  const d = t.dashboard;
  const stats: [string, string][] = [
    [d.statActiveCampaigns, "8"],
    [d.statDmsSent, "1 284"],
    [d.statSkipped, "42"],
    [d.statFailed, "3"],
    [d.statClicks, "356"],
    [d.statCtr, "27.7%"],
  ];
  const activity: [string, string, "lime" | "warning"][] = [
    ["@maya.co", "Sent", "lime"],
    ["@founder.ray", "Sent", "lime"],
    ["@shop.ava", "Queued", "warning"],
  ];
  const maxDM = Math.max(...dashboardChart.map(([, n]) => n));

  return (
    <div className="overflow-hidden rounded-3xl bg-surface text-white shadow-float">
      <div className="flex items-center justify-between gap-3 bg-surface-hover px-5 py-3.5">
        <Wordmark markClassName="h-6 w-6" textClassName="text-[0.95rem]" />
        <span className="flex items-center gap-2 rounded-full bg-midnight px-3 py-1 text-xs font-medium">
          <span className="h-2 w-2 rounded-full bg-lime" />@{username}
        </span>
      </div>
      <div className="p-5 sm:p-6">
        <p className="display text-[1.2rem]">{d.greeting("Maya")}</p>
        <p className="mt-1 text-sm text-muted">
          {d.connectedAccount(2)} · {d.contact(340)}
        </p>

        <div className="mt-5 grid grid-cols-3 gap-2.5">
          {stats.map(([label, value]) => (
            <div key={label} className="min-w-0 rounded-2xl bg-surface-hover px-3 py-3">
              <p className="truncate text-[11px] font-medium text-muted">{label}</p>
              <p className="display mt-1.5 truncate text-[1.15rem] tabular-nums">{value}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-2xl bg-surface-hover p-4">
          <p className="text-sm font-semibold">{d.chartTitle}</p>
          <div className="mt-4 flex h-28 items-end gap-2">
            {dashboardChart.map(([day, n]) => (
              <div key={day} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                <div
                  className="w-full rounded-t-md bg-lime"
                  style={{ height: `${Math.max((n / maxDM) * 100, 6)}%` }}
                />
                <span className="text-[10px] text-muted">{day}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 rounded-2xl bg-surface-hover p-4">
          <p className="text-sm font-semibold">{d.recentActivity}</p>
          <div className="mt-2">
            {activity.map(([user, status, tone]) => (
              <div key={user} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="truncate">{user}</span>
                <span className={tone === "lime" ? "text-lime" : "text-warning"}>{status}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default async function Home() {
  const [locale, pricingPlans] = await Promise.all([
    getServerLocale(),
    // The landing page must render even when Postgres is unreachable: fall
    // back to the seeded plans rather than failing the whole page.
    getActivePricingPlans().catch((error: unknown) => {
      console.error("[home] pricing plans unavailable, rendering defaults", error);
      return getDefaultPricingPlans();
    }),
  ]);
  const t = dictionaries[locale];
  const h = t.home;

  const steps = [
    { title: h.step1Title, body: h.step1Body },
    { title: h.step2Title, body: h.step2Body },
    { title: h.step3Title, body: h.step3Body },
  ];

  return (
    <main className="min-h-screen bg-midnight text-white">
      {/* Static, hand-authored JSON — not user input. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <PublicSiteHeader active="home" />

      {/* ---------- Hero: the product, live, in the shape of its logo ---------- */}
      <section className="overflow-hidden">
        <Container className="pb-24 pt-12 sm:pt-16 lg:pb-32 lg:pt-20">
          <h1 className="display text-[2.15rem] sm:text-[3.4rem] lg:text-[4.3rem] xl:text-[4.75rem]">
            {h.heroTitle}
          </h1>

          <div className="mt-10 grid gap-12 lg:mt-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start lg:gap-16">
            <div className="min-w-0 lg:pt-10">
              <p className="max-w-xl text-xl leading-9 text-cloud/90">{h.heroSubtitle}</p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Link href="/login" className="btn btn-primary">
                  {h.getStarted}
                </Link>
                <a href="#how" className="btn btn-ghost">
                  {h.seeHowItWorks}
                </a>
              </div>
              <p className="mt-8 max-w-md text-base leading-7 text-muted">{h.factsLine}</p>
            </div>

            <div className="min-w-0 py-6 lg:py-0">
              <HeroDemo
                copy={{
                  ...h.demo,
                  triggerLabel: t.publicSite.triggerLabel,
                  replyLabel: t.publicSite.privateReplyLabel,
                }}
              />
            </div>
          </div>
        </Container>
      </section>

      {/* ---------- How it works: three chapters, three colours of the mark ---------- */}
      <section id="how" className="scroll-mt-20">
        <Container className="pb-16 pt-8 lg:pb-24 lg:pt-12">
          <Reveal>
            <h2 className={`${h2} max-w-4xl`}>{h.howItWorksTitle}</h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-cloud/85">{h.howItWorksBody}</p>
          </Reveal>
        </Container>

        {/* Chapter: connect — Electric Violet, the comment arrives */}
        <div className="bg-violet text-white">
          <Container className="grid gap-12 py-24 lg:grid-cols-2 lg:items-center lg:py-32">
            <Reveal>
              <h3 className={h3}>{steps[0].title}</h3>
              <p className="mt-6 max-w-xl text-lg leading-8 text-white/85">{steps[0].body}</p>
            </Reveal>
            <Reveal delay={120} className="flex lg:justify-end">
              <CommentSolid />
            </Reveal>
          </Container>
        </div>

        {/* Chapter: create — Signal Lime, the keyword is the trigger */}
        <div className="bg-lime text-midnight">
          <Container className="grid gap-12 py-24 lg:grid-cols-2 lg:items-center lg:py-32">
            <Reveal delay={120} className="order-2 flex lg:order-1">
              <TriggerSolid keyword={h.demo.keyword} />
            </Reveal>
            <Reveal className="order-1 lg:order-2">
              <h3 className={h3}>{steps[1].title}</h3>
              <p className="mt-6 max-w-xl text-lg leading-8 text-midnight/80">{steps[1].body}</p>
            </Reveal>
          </Container>
        </div>

        {/* Chapter: deliver — Cloud, the DM goes out */}
        <div className="bg-cloud text-midnight">
          <Container className="py-24 lg:py-32">
            <Reveal>
              <h3 className={`${h3} max-w-3xl`}>{steps[2].title}</h3>
            </Reveal>
            <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-end">
              <Reveal delay={90}>
                <p className="max-w-2xl text-lg leading-8 text-slate">{steps[2].body}</p>
              </Reveal>
              <Reveal delay={160} className="flex lg:justify-end">
                <DmSolid />
              </Reveal>
            </div>
          </Container>
        </div>
      </section>

      {/* ---------- Dashboard proof ---------- */}
      <section>
        <Container className="py-24 lg:py-36">
          <Reveal>
            <h2 className={`${h2} max-w-5xl`}>{h.dashboardTitle}</h2>
          </Reveal>
          <div className="mt-10 grid gap-14 lg:mt-14 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-start lg:gap-20">
            <Reveal delay={90}>
              <p className="max-w-xl text-lg leading-8 text-cloud/85">{h.dashboardBody}</p>
            </Reveal>
            <Reveal delay={160} className="min-w-0">
              <Tilt>
                <DashboardPreview t={t} username={h.demo.username} />
              </Tilt>
            </Reveal>
          </div>
        </Container>
      </section>

      {/* ---------- Trust ---------- */}
      <section className="bg-surface">
        <Container className="py-24 lg:py-36">
          <Reveal>
            <h2 className={`${h2} max-w-5xl`}>{h.trustTitle}</h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-cloud/85">{h.trustBody}</p>
          </Reveal>
          <div className="mt-16 grid gap-x-12 gap-y-12 sm:grid-cols-2 lg:mt-24">
            {h.trustPoints.map((point, i) => (
              <Reveal key={point.title} delay={i * 80}>
                <h3 className="display text-[1.3rem] sm:text-[1.5rem]">{point.title}</h3>
                <p className="mt-4 max-w-md text-lg leading-8 text-cloud/80">{point.body}</p>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      {/* ---------- Features ---------- */}
      <section id="features">
        <Container className="py-24 lg:py-36">
          <Reveal>
            <h2 className={`${h2} max-w-5xl`}>{h.featuresTitle}</h2>
          </Reveal>
          <div className="mt-10 grid gap-12 lg:mt-14 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20">
          <Reveal delay={90}>
            <p className="max-w-md text-lg leading-8 text-cloud/85">{h.featuresBody}</p>
          </Reveal>
          <Reveal delay={160}>
            <ul className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
              {h.features.map((feature) => (
                <li key={feature} className="flex items-start gap-4 text-lg leading-8">
                  <span aria-hidden="true" className="mt-3 h-2.5 w-2.5 shrink-0 bg-lime" />
                  {feature}
                </li>
              ))}
            </ul>
          </Reveal>
          </div>
        </Container>
      </section>

      {/* ---------- Pricing: real plans, light field ---------- */}
      {pricingPlans.length > 0 && (
        <section id="pricing" className="scroll-mt-20 bg-cloud text-midnight">
          <Container className="py-24 lg:py-36">
            <Reveal>
              <h2 className={`${h2} max-w-5xl`}>{h.pricingTitle}</h2>
            </Reveal>
            <Reveal delay={90}>
              <p className="mt-7 max-w-2xl text-lg leading-8 text-slate">{h.pricingBody}</p>
            </Reveal>

            <div className="mt-16 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {pricingPlans.map((plan, i) => {
                const copy = plan.content[locale];
                const featured = plan.isFeatured;
                return (
                  <Reveal key={plan.id} delay={i * 90} className="flex">
                    <div
                      className={`flex w-full flex-col rounded-3xl p-8 ${
                        featured ? "bg-violet text-white" : "bg-white text-midnight"
                      }`}
                    >
                      <h3 className="display text-[1.5rem]">{copy.name}</h3>
                      <p
                        className={`mt-3 text-base leading-7 ${
                          featured ? "text-white/85" : "text-slate"
                        }`}
                      >
                        {copy.description}
                      </p>
                      <p className="display mt-8 text-[2.75rem] tabular-nums">
                        {plan.priceCurrency}
                        {plan.priceAmount}
                        <span
                          className={`ml-1 font-sans text-base font-medium tracking-normal ${
                            featured ? "text-white/80" : "text-slate"
                          }`}
                        >
                          {plan.priceSuffix}
                        </span>
                      </p>
                      {featured && (
                        <p className="mt-2 text-sm font-semibold text-lime">
                          {h.pricingMostPopular}
                        </p>
                      )}
                      <ul className="mt-8 space-y-3">
                        {copy.features.map((feature) => (
                          <li key={feature} className="flex items-start gap-3 text-base leading-7">
                            <span
                              aria-hidden="true"
                              className={`mt-2.5 h-2 w-2 shrink-0 ${
                                featured ? "bg-lime" : "bg-violet"
                              }`}
                            />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      <Link
                        href="/login"
                        className={`btn mt-10 w-full ${featured ? "btn-lime" : "btn-primary"}`}
                      >
                        {h.getStarted}
                      </Link>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </Container>
        </section>
      )}

      {/* ---------- FAQ ---------- */}
      <section id="faq">
        <Container className="py-24 lg:py-36">
          <Reveal>
            <h2 className={`${h2} max-w-5xl`}>{h.faqTitle}</h2>
          </Reveal>
          <div className="mt-14 grid gap-x-16 gap-y-12 lg:mt-20 lg:grid-cols-2">
            {h.faqs.map((faq, i) => (
              <Reveal key={faq.question} delay={i * 60}>
                <h3 className="display text-[1.25rem] sm:text-[1.45rem]">{faq.question}</h3>
                <p className="mt-4 max-w-xl text-lg leading-8 text-cloud/80">{faq.answer}</p>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      {/* ---------- Close: Electric Violet field ---------- */}
      <section className="bg-violet text-white">
        <Container className="py-24 lg:py-36">
          <Reveal>
            <h2 className="display max-w-5xl text-[2.2rem] sm:text-[3.25rem] lg:text-[4.25rem]">
              {h.ctaTitle}
            </h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mt-7 max-w-2xl text-xl leading-9 text-white/85">{h.ctaBody}</p>
          </Reveal>
          <Reveal delay={160}>
            <Link href="/login" className="btn btn-lime mt-10 !px-8 !py-4 !text-lg">
              {h.getStarted}
            </Link>
          </Reveal>
        </Container>
      </section>

      <SiteFooter />
    </main>
  );
}
