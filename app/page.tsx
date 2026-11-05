import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import type { Dictionary } from "@/lib/i18n/dictionary";
import PublicSiteHeader from "@/components/public-site-header";
import SiteFooter from "@/components/site-footer";
import HeroDemo from "@/components/brand/hero-demo";
import Reveal from "@/components/brand/reveal";
import Tilt from "@/components/brand/tilt";
import DepthStage from "@/components/brand/depth-stage";
import CountUp from "@/components/brand/count-up";
import Orbit, { ORBIT_NETWORKS } from "@/components/brand/orbit";
import CardStack from "@/components/brand/card-stack";
import MarkScene from "@/components/brand/mark-scene";
import { CommentSolid, DmSolid, TriggerSolid } from "@/components/brand/shapes";
import { BrandIcon, type BrandKey } from "@/components/brand-icons";
import Icon from "@/components/icons";
import { Wordmark } from "@/components/logo-mark";
import { getActivePricingPlans, getDefaultPricingPlans } from "@/lib/pricing";
import { LANDING } from "@/lib/landing/content";
import { HOME_SEO, homeMetadata } from "@/lib/seo/home-metadata";
import { buildHomeJsonLd, serializeJsonLd } from "@/lib/seo/home-structured-data";

const BASE_URL = (process.env.NEXTAUTH_URL ?? "https://socialauto.uz").replace(/\/$/, "");

/** Title, description and og:locale in the visitor's language (NEXT_LOCALE cookie). */
export async function generateMetadata(): Promise<Metadata> {
  return homeMetadata(await getServerLocale());
}

const NETWORK_NAME: Record<BrandKey, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  youtube: "YouTube",
  telegram: "Telegram",
};

function Container({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`mx-auto w-full max-w-7xl px-5 sm:px-8 ${className}`}>{children}</div>;
}

/* Section heading scale: one display size for every chapter. */
// Long Russian words ("профессиональный") must break on a 320 px phone, not widen the grid.
const h2 = "display hyphens-auto break-words text-[2rem] sm:text-[2.75rem] lg:text-[3.4rem]";
const h3 = "display hyphens-auto break-words text-[1.7rem] sm:text-[2.1rem] lg:text-[2.4rem]";

/* Network tiles floating around the hero demo, each on its own depth: the
   bigger the shift, the nearer it reads. Placed in the demo's empty corners
   (top right, bottom left) so they never cover the comment or the DM. */
const HERO_FLOATERS: {
  brand: BrandKey;
  pos: CSSProperties;
  size: string;
  shift: string;
  tilt: string;
  dur: string;
  delay: string;
}[] = [
  { brand: "instagram", pos: { right: "3%", top: "2%" }, size: "4.25rem", shift: "26px", tilt: "8deg", dur: "9s", delay: "0s" },
  { brand: "telegram", pos: { right: "17%", top: "17%" }, size: "3rem", shift: "14px", tilt: "-6deg", dur: "11s", delay: "-3s" },
  { brand: "youtube", pos: { left: "2%", bottom: "14%" }, size: "3.75rem", shift: "22px", tilt: "-9deg", dur: "10s", delay: "-5s" },
  { brand: "facebook", pos: { left: "17%", bottom: "1%" }, size: "2.75rem", shift: "12px", tilt: "5deg", dur: "12s", delay: "-7s" },
];

/* The use-case deck: one brand field per card, in the order of the mark. */
const STACK_TONES = [
  { card: "bg-violet text-white", soft: "text-white/80", step: "bg-white/12", num: "bg-lime text-midnight", btn: "btn-lime" },
  { card: "bg-lime text-midnight", soft: "text-midnight/75", step: "bg-midnight/8", num: "bg-midnight text-lime", btn: "btn-primary" },
  { card: "bg-cloud text-midnight", soft: "text-slate", step: "bg-midnight/6", num: "bg-violet text-white", btn: "btn-primary" },
  { card: "bg-surface text-white", soft: "text-cloud/75", step: "bg-white/8", num: "bg-lime text-midnight", btn: "btn-lime" },
] as const;

/* A faithful, static copy of the real Dashboard screen in the app's own
   tokens, so what visitors see is what the app looks like. The numbers are
   an example and the page says so under the picture. */

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
  const L = LANDING[locale];

  const steps = [
    { title: h.step1Title, body: h.step1Body },
    { title: h.step2Title, body: h.step2Body },
    { title: h.step3Title, body: h.step3Body },
  ];
  const faqs = [...h.faqs, ...L.faqs];
  const trustPoints = [...h.trustPoints, ...L.trustExtra];

  // Organisation, site, application with the real plans as offers, and the
  // FAQ — the same facts the page shows, nothing invented (no ratings).
  const jsonLd = buildHomeJsonLd({
    locale,
    baseUrl: BASE_URL,
    description: HOME_SEO[locale].description,
    plans: pricingPlans,
    faqs,
  });

  const sections = [
    { label: L.nav.networks, href: "#networks" },
    { label: L.nav.modules, href: "#modules" },
    { label: L.nav.useCases, href: "#use-cases" },
    ...(pricingPlans.length > 0 ? [{ label: L.nav.pricing, href: "#pricing" }] : []),
    { label: L.nav.faq, href: "#faq" },
  ];

  return (
    <main className="min-h-screen bg-midnight text-white">
      {/* Built from our own copy and admin-published plans; "<" is escaped. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      <PublicSiteHeader active="home" sections={sections} />

      {/* ---------- Hero: the product, live, with the networks floating at depth ---------- */}
      <DepthStage as="section" className="overflow-hidden">
        <Container className="pb-20 pt-12 sm:pt-16 lg:pb-28 lg:pt-20">
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
              <div className="mt-10">
                {/* The line below names every network; the logos are its picture. */}
                <ul aria-hidden="true" className="flex flex-wrap items-center gap-2.5">
                  {ORBIT_NETWORKS.map((network) => (
                    <li key={network} className="grid h-11 w-11 place-items-center rounded-full bg-surface">
                      <BrandIcon brand={network} className="h-5 w-5" />
                    </li>
                  ))}
                </ul>
                <p className="mt-4 max-w-md text-base leading-7 text-muted">{L.networksLine}</p>
              </div>
            </div>

            <div className="relative min-w-0 py-6 lg:py-0">
              <div className="parallax" style={{ "--shift": "8px" } as CSSProperties}>
                <HeroDemo
                  copy={{
                    ...h.demo,
                    triggerLabel: t.publicSite.triggerLabel,
                    replyLabel: t.publicSite.privateReplyLabel,
                  }}
                />
              </div>
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden sm:block">
                {HERO_FLOATERS.map((f) => (
                  <div key={f.brand} className="parallax absolute" style={{ ...f.pos, "--shift": f.shift } as CSSProperties}>
                    <div
                      className="floater grid place-items-center rounded-2xl bg-surface-hover shadow-float"
                      style={{ width: f.size, height: f.size, "--tilt": f.tilt, "--dur": f.dur, "--delay": f.delay } as CSSProperties}
                    >
                      <BrandIcon brand={f.brand} className="h-[46%] w-[46%]" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Container>
      </DepthStage>

      {/* ---------- Proof: mechanisms, not invented customer counts ---------- */}
      <section className="bg-surface">
        <Container className="grid grid-cols-2 gap-x-6 gap-y-10 py-14 lg:grid-cols-4 lg:py-16">
          {L.proof.map((stat) => (
            <div key={stat.label} className="min-w-0">
              <p className="display text-[2.6rem] text-lime sm:text-[3.4rem]">
                <CountUp value={stat.value} suffix={stat.suffix} />
              </p>
              <p className="mt-2 max-w-[14rem] text-base leading-6 text-cloud/80">{stat.label}</p>
            </div>
          ))}
        </Container>
      </section>

      {/* ---------- How it works: three chapters, three colours of the mark ---------- */}
      <section id="how" className="scroll-mt-20">
        <Container className="pb-16 pt-24 lg:pb-24 lg:pt-32">
          <Reveal variant="mask">
            <h2 className={`${h2} max-w-4xl`}>{h.howItWorksTitle}</h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-cloud/85">{h.howItWorksBody}</p>
          </Reveal>
        </Container>

        {/* Chapter: connect — Electric Violet, the comment arrives */}
        <div className="overflow-hidden bg-violet text-white">
          <Container className="grid gap-12 py-24 lg:grid-cols-2 lg:items-center lg:py-32">
            <Reveal className="min-w-0">
              <h3 className={h3}>{steps[0].title}</h3>
              <p className="mt-6 max-w-xl text-lg leading-8 text-white/85">{steps[0].body}</p>
            </Reveal>
            <div className="turn-in flex min-w-0 lg:justify-end">
              <CommentSolid />
            </div>
          </Container>
        </div>

        {/* Chapter: create — Signal Lime, the keyword is the trigger */}
        <div className="overflow-hidden bg-lime text-midnight">
          <Container className="grid gap-12 py-24 lg:grid-cols-2 lg:items-center lg:py-32">
            <div className="turn-in order-2 flex min-w-0 lg:order-1">
              <TriggerSolid keyword={h.demo.keyword} />
            </div>
            <Reveal className="order-1 min-w-0 lg:order-2">
              <h3 className={h3}>{steps[1].title}</h3>
              <p className="mt-6 max-w-xl text-lg leading-8 text-midnight/80">{steps[1].body}</p>
            </Reveal>
          </Container>
        </div>

        {/* Chapter: deliver — Cloud, the DM goes out */}
        <div className="overflow-hidden bg-cloud text-midnight">
          <Container className="py-24 lg:py-32">
            <Reveal>
              <h3 className={`${h3} max-w-3xl`}>{steps[2].title}</h3>
            </Reveal>
            <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-end">
              <Reveal delay={90}>
                <p className="max-w-2xl text-lg leading-8 text-slate">{steps[2].body}</p>
              </Reveal>
              <div className="turn-in flex lg:justify-end">
                <DmSolid />
              </div>
            </div>
          </Container>
        </div>
      </section>

      {/* ---------- Networks: the five logos in orbit around the mark ---------- */}
      <section id="networks" className="scroll-mt-20 overflow-hidden">
        <Container className="py-24 lg:py-36">
          <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-20">
            <div className="min-w-0">
              <Reveal variant="mask">
                <h2 className={`${h2} max-w-xl`}>{L.networksTitle}</h2>
              </Reveal>
              <Reveal delay={90}>
                <p className="mt-7 max-w-xl text-lg leading-8 text-cloud/85">{L.networksBody}</p>
              </Reveal>
              <ul className="mt-12 space-y-6">
                {ORBIT_NETWORKS.map((network, i) => (
                  <li key={network}>
                    <Reveal delay={i * 70} className="flex items-start gap-4">
                      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-surface">
                        <BrandIcon brand={network} className="h-6 w-6" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-lg font-semibold">{NETWORK_NAME[network]}</span>
                        <span className="mt-1 block text-base leading-7 text-cloud/75">{L.networks[network]}</span>
                      </span>
                    </Reveal>
                  </li>
                ))}
              </ul>
            </div>
            <div className="order-first min-w-0 lg:order-last">
              <Orbit />
            </div>
          </div>
        </Container>
      </section>

      {/* ---------- Modules: everything the panel does, one card each ---------- */}
      <section id="modules" className="scroll-mt-20 bg-surface">
        <Container className="py-24 lg:py-36">
          <Reveal variant="mask">
            <h2 className={`${h2} max-w-5xl`}>{L.modulesTitle}</h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-cloud/85">{L.modulesBody}</p>
          </Reveal>
          <ul className="mt-16 grid gap-4 sm:grid-cols-2 lg:mt-20 lg:grid-cols-3">
            {L.modules.map((module, i) => (
              <li key={module.title} className="flex">
                <Reveal delay={(i % 3) * 80} className="flex w-full">
                  <div className="lift w-full rounded-3xl bg-midnight p-6 sm:p-8">
                    {/* Phones: icon beside the title, so twelve cards stay a short scroll. */}
                    <div className="flex items-center gap-4 sm:block">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-violet text-white sm:h-12 sm:w-12">
                        <Icon name={module.icon} className="h-5 w-5" />
                      </span>
                      <h3 className="display text-[1.1rem] leading-snug sm:mt-6 sm:text-[1.3rem]">{module.title}</h3>
                    </div>
                    <p className="mt-3 text-base leading-7 text-cloud/75">{module.body}</p>
                  </div>
                </Reveal>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      {/* ---------- Dashboard proof ---------- */}
      <section>
        <Container className="py-24 lg:py-36">
          <Reveal variant="mask">
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
              <p className="mt-5 text-sm text-muted">{L.sampleData}</p>
            </Reveal>
          </div>
        </Container>
      </section>

      {/* ---------- Use cases: a sticky deck, each card recedes under the next ---------- */}
      <section id="use-cases" className="scroll-mt-20">
        <Container className="pt-8 lg:pt-12">
          <Reveal variant="mask">
            <h2 className={`${h2} max-w-4xl`}>{L.useCasesTitle}</h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-cloud/85">{L.useCasesBody}</p>
          </Reveal>
        </Container>
        <Container className="pb-24 pt-14 lg:pb-36 lg:pt-20">
          <CardStack className="space-y-6 lg:space-y-10">
            {L.useCases.map((useCase, i) => {
              const tone = STACK_TONES[i % STACK_TONES.length];
              return (
                <article
                  key={useCase.title}
                  data-stack-card
                  className={`stack-card rounded-[2rem] p-7 sm:p-10 lg:p-14 ${tone.card}`}
                  style={{ "--i": i } as CSSProperties}
                >
                  <div className="grid gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center lg:gap-16">
                    <div className="min-w-0">
                      <h3 className="display text-[1.8rem] sm:text-[2.4rem]">{useCase.title}</h3>
                      <p className={`mt-2 text-base font-medium ${tone.soft}`}>{useCase.who}</p>
                      <p className={`mt-6 max-w-xl text-lg leading-8 ${tone.soft}`}>{useCase.body}</p>
                      <Link href={useCase.href} className={`btn mt-8 ${tone.btn}`}>
                        {useCase.cta}
                      </Link>
                    </div>
                    <ol className="flex min-w-0 flex-col gap-3">
                      {useCase.flow.map((step, j) => (
                        <li key={step} className={`flex items-center gap-4 rounded-full py-2.5 pl-2.5 pr-6 text-base font-semibold sm:text-lg ${tone.step}`}>
                          <span className={`display grid h-10 w-10 shrink-0 place-items-center rounded-full text-base ${tone.num}`}>
                            {j + 1}
                          </span>
                          <span className="min-w-0">{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </article>
              );
            })}
          </CardStack>
        </Container>
      </section>

      {/* ---------- Trust ---------- */}
      <section className="bg-surface">
        <Container className="py-24 lg:py-36">
          <Reveal variant="mask">
            <h2 className={`${h2} max-w-5xl`}>{h.trustTitle}</h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-cloud/85">{h.trustBody}</p>
          </Reveal>
          <div className="mt-16 grid gap-x-12 gap-y-12 sm:grid-cols-2 lg:mt-24 lg:grid-cols-3">
            {trustPoints.map((point, i) => (
              <Reveal key={point.title} delay={(i % 3) * 80}>
                <h3 className="display text-[1.3rem] sm:text-[1.5rem]">{point.title}</h3>
                <p className="mt-4 max-w-md text-lg leading-8 text-cloud/80">{point.body}</p>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      {/* ---------- Comparison with a broad chatbot builder ---------- */}
      <section id="compare" className="scroll-mt-20">
        <Container className="py-24 lg:py-36">
          <Reveal variant="mask">
            <h2 className={`${h2} max-w-4xl`}>{L.compareTitle}</h2>
          </Reveal>
          <Reveal delay={90}>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-cloud/85">{L.compareBody}</p>
          </Reveal>
          <Reveal delay={160}>
            <table className="mt-14 w-full border-separate border-spacing-y-3 text-left lg:mt-20">
              <caption className="sr-only">{L.compareTitle}</caption>
              <thead className="max-md:sr-only">
                <tr>
                  <th scope="col" className="px-6 pb-2 text-base font-semibold text-muted">
                    {L.compareHead.need}
                  </th>
                  <th scope="col" className="px-6 pb-2 text-base font-semibold text-lime">
                    {L.compareHead.ours}
                  </th>
                  <th scope="col" className="px-6 pb-2 text-base font-semibold text-muted">
                    {L.compareHead.other}
                  </th>
                </tr>
              </thead>
              <tbody>
                {L.compareRows.map((row) => (
                  <tr key={row.label} className="max-md:mb-3 max-md:grid max-md:gap-3 max-md:rounded-3xl max-md:bg-surface max-md:p-6">
                    <th scope="row" className="display align-top text-[1.1rem] leading-snug md:w-[24%] md:rounded-l-3xl md:bg-surface md:px-6 md:py-6 md:text-[1.2rem] md:leading-8">
                      {row.label}
                    </th>
                    <td className="align-top text-base leading-7 md:bg-surface md:px-6 md:py-6 md:text-lg md:leading-8">
                      <span className="flex items-start gap-3">
                        <span aria-hidden="true" className="mt-2.5 h-2 w-2 shrink-0 rounded-full bg-lime" />
                        <span>
                          <span className="font-semibold md:hidden">{L.compareHead.ours}: </span>
                          {row.ours}
                        </span>
                      </span>
                    </td>
                    <td className="align-top text-base leading-7 text-cloud/60 md:rounded-r-3xl md:bg-surface md:px-6 md:py-6 md:text-lg md:leading-8">
                      <span className="md:hidden">{L.compareHead.other}: </span>
                      {row.other}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>
          <Reveal delay={200}>
            <Link href="/manychat-alternative" className="btn btn-ghost mt-10 max-w-full whitespace-normal text-center">
              {L.compareLink}
            </Link>
          </Reveal>
        </Container>
      </section>

      {/* ---------- Pricing: real plans, light field ---------- */}
      {pricingPlans.length > 0 && (
        <section id="pricing" className="scroll-mt-20 bg-cloud text-midnight">
          <Container className="py-24 lg:py-36">
            <Reveal variant="mask">
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

      {/* ---------- FAQ: native disclosure, every answer in the HTML ---------- */}
      <section id="faq" className="scroll-mt-20">
        <Container className="py-24 lg:py-36">
          <Reveal variant="mask">
            <h2 className={`${h2} max-w-5xl`}>{h.faqTitle}</h2>
          </Reveal>
          <div className="mt-14 grid max-w-4xl grid-cols-1 gap-4 lg:mt-20">
            {faqs.map((faq, i) => (
              <Reveal key={faq.question} delay={Math.min(i, 4) * 50}>
                <details className="group rounded-3xl bg-surface px-6 py-5 sm:px-8 sm:py-6">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-6 [&::-webkit-details-marker]:hidden">
                    <h3 className="display min-w-0 hyphens-auto break-words text-[1.1rem] leading-snug sm:text-[1.25rem]">{faq.question}</h3>
                    <span
                      aria-hidden="true"
                      className="display grid h-9 w-9 shrink-0 place-items-center rounded-full bg-midnight text-lg text-lime transition-transform duration-300 group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="mt-4 max-w-3xl pr-4 text-lg leading-8 text-cloud/80">{faq.answer}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </Container>
      </section>

      {/* ---------- Close: Electric Violet field, the mark assembling in 3D ---------- */}
      <section className="overflow-hidden bg-violet text-white">
        <Container className="grid gap-12 py-24 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.7fr)] lg:items-center lg:py-32">
          <div className="min-w-0">
            <Reveal variant="mask">
              <h2 className="display max-w-4xl text-[2.2rem] sm:text-[3.25rem] lg:text-[4.25rem]">
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
          </div>
          <div aria-hidden="true" className="hidden min-w-0 lg:block">
            <MarkScene tone="violet" className="mx-auto max-w-[22rem]" />
          </div>
        </Container>
      </section>

      <SiteFooter />
    </main>
  );
}
