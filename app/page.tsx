import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import PublicSiteHeader from "@/components/public-site-header";
import SiteFooter from "@/components/site-footer";

export const metadata: Metadata = {
  title: "SocialAuto - Instagram comment-to-DM automation",
  description:
    "Turn Instagram keyword comments into automatic private replies using the official Meta API.",
};

/* Static, faithful copies of the real Overview and Dashboard screens, built in
   the app's own design tokens so what visitors see is what the app looks like. */

function AppWindow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border-2 border-border bg-background shadow-2xl shadow-black/50">
      <div className="flex items-center gap-2 border-b-2 border-border bg-surface px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="label-mono ml-2 text-[11px] text-muted">{label}</span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel rounded p-4">
      <p className="label-mono text-[11px] text-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-extrabold text-foreground">
        {value}
      </p>
    </div>
  );
}

const overviewStats = [
  ["Views", "847.2K"],
  ["Reach", "612.4K"],
  ["Likes", "38.1K"],
  ["Comments", "4,204"],
  ["Saved", "9,712"],
  ["Shares", "2,340"],
];

const overviewPosts = [
  ["Spring drop reel", "214.8K", "9.1K", "Apr 3"],
  ["Restock haul", "88.4K", "5.2K", "Mar 28"],
  ["Behind the studio", "51.3K", "3.4K", "Mar 21"],
];

function OverviewPreview() {
  return (
    <AppWindow label="app / overview">
      <div className="flex items-end justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Overview</h3>
          <p className="mt-1 text-xs text-muted">
            Recent — 24 posts from @studio.store
          </p>
        </div>
        <span className="rounded border border-border px-2 py-1 text-xs text-muted">
          Last 50
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {overviewStats.map(([label, value]) => (
          <Stat key={label} label={label} value={value} />
        ))}
      </div>

      <div className="mt-4 rounded border border-border bg-surface p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold text-foreground">
            Followers over time
          </p>
          <p className="text-xs text-muted">
            48,210 <span className="text-success">+1,240</span> · 30d
          </p>
        </div>
        <svg
          viewBox="0 0 300 64"
          preserveAspectRatio="none"
          className="mt-3 h-16 w-full"
          aria-hidden="true"
        >
          <polyline
            points="0,54 43,49 86,51 129,40 171,36 214,26 257,20 300,9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className="text-accent"
          />
        </svg>
      </div>

      <div className="mt-4 rounded border border-border bg-surface p-4">
        <p className="text-sm font-semibold text-foreground">Posts</p>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="label-mono border-b border-border text-left text-[11px] text-muted">
              <th className="pb-2 pr-3 font-medium">Post</th>
              <th className="pb-2 px-3 text-right font-medium">Views</th>
              <th className="pb-2 px-3 text-right font-medium">Likes</th>
              <th className="pb-2 pl-3 text-right font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {overviewPosts.map(([post, views, likes, date]) => (
              <tr key={post} className="border-b border-border last:border-0">
                <td className="py-2 pr-3 text-foreground">{post}</td>
                <td className="py-2 px-3 text-right text-muted">{views}</td>
                <td className="py-2 px-3 text-right text-muted">{likes}</td>
                <td className="py-2 pl-3 text-right text-muted">{date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppWindow>
  );
}

function MatchedCommentCard() {
  return (
    <div className="w-64 rounded-lg border-2 border-border bg-surface p-4 shadow-2xl shadow-black/50">
      <p className="text-xs text-muted">New comment</p>
      <p className="mt-1 text-sm font-semibold text-foreground">@maya.co</p>
      <p className="mt-1 text-sm text-muted">LINK please</p>
      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs text-muted">
          Matched <span className="text-accent">GUIDE</span>
        </p>
        <p className="mt-1 text-sm font-medium text-success">
          Queued private reply
        </p>
      </div>
    </div>
  );
}

const dashboardStats = [
  ["Active Campaigns", "8"],
  ["DMs Sent", "1,284"],
  ["Skipped", "42"],
  ["Failed", "3"],
  ["Clicks", "356"],
  ["CTR", "27.7%"],
];

const dashboardChart: [string, number][] = [
  ["Mon", 42],
  ["Tue", 68],
  ["Wed", 51],
  ["Thu", 94],
  ["Fri", 120],
  ["Sat", 86],
  ["Sun", 73],
];

const dashboardActivity = [
  ["@maya.co", "Product guide reply", "Sent", "text-success"],
  ["@founder.ray", "Price request", "Sent", "text-success"],
  ["@shop.ava", "Lead magnet", "Queued", "text-warning"],
];

function DashboardPreview() {
  const maxDM = Math.max(...dashboardChart.map(([, n]) => n));
  return (
    <AppWindow label="app / dashboard">
      <h3 className="text-base font-semibold text-foreground">Hello, Maya!</h3>
      <p className="mt-1 text-xs text-muted">2 connected accounts · 340 contacts</p>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {dashboardStats.map(([label, value]) => (
          <Stat key={label} label={label} value={value} />
        ))}
      </div>

      <div className="mt-4 rounded border border-border bg-surface p-4">
        <p className="text-sm font-semibold text-foreground">DMs — Last 7 Days</p>
        <div className="mt-4 flex h-32 items-end gap-2">
          {dashboardChart.map(([day, n]) => (
            <div key={day} className="flex flex-1 flex-col items-center gap-2">
              <span className="text-[10px] text-muted">{n}</span>
              <div
                className="w-full rounded-sm bg-accent"
                style={{ height: `${Math.max((n / maxDM) * 100, 4)}%` }}
              />
              <span className="text-[10px] text-muted">{day}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded border border-border bg-surface p-4">
        <p className="text-sm font-semibold text-foreground">Recent Activity</p>
        <div className="mt-3 space-y-2">
          {dashboardActivity.map(([user, automation, status, color]) => (
            <div
              key={user}
              className="flex items-center justify-between gap-3 border-b border-border py-2 text-sm last:border-0"
            >
              <span className="truncate text-foreground">{user}</span>
              <span className="truncate text-muted">{automation}</span>
              <span className={`text-sm ${color}`}>{status}</span>
            </div>
          ))}
        </div>
      </div>
    </AppWindow>
  );
}

export default async function Home() {
  const locale = await getServerLocale();
  const t = dictionaries[locale];

  const heroStats = [
    { value: t.home.statMonitoring, label: t.home.statMonitoringLabel },
    { value: t.home.statOnePerComment, label: t.home.statOnePerCommentLabel },
    { value: t.home.statZeroScraping, label: t.home.statZeroScrapingLabel },
  ];

  const flowSteps = [
    { eyebrow: t.home.step1Eyebrow, title: t.home.step1Title, description: t.home.step1Body },
    { eyebrow: t.home.step2Eyebrow, title: t.home.step2Title, description: t.home.step2Body },
    { eyebrow: t.home.step3Eyebrow, title: t.home.step3Title, description: t.home.step3Body },
  ];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicSiteHeader active="home" />

      <section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 pb-16 pt-12 sm:px-6 sm:pt-18 lg:grid-cols-[0.95fr_1.05fr] lg:px-8 lg:pb-24">
        <div className="max-w-3xl">
          <div className="label-mono inline-flex items-center gap-2 rounded border-2 border-border bg-surface px-3 py-2 text-xs font-semibold text-muted">
            {t.home.officialApi}
          </div>

          <h1 className="mt-7 text-balance font-display text-5xl font-extrabold leading-[1.02] text-foreground sm:text-6xl lg:text-7xl">
            {t.home.heroTitle}
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
            {t.home.heroSubtitle}
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/login"
              className="label-mono inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3 text-xs font-bold text-background transition hover:bg-accent-hover"
            >
              {t.home.getStarted}
            </Link>
            <a
              href="#how"
              className="label-mono inline-flex items-center justify-center rounded border-2 border-border bg-transparent px-6 py-3 text-xs font-bold text-foreground transition hover:border-border-hover hover:bg-surface-hover"
            >
              {t.home.seeHowItWorks}
            </a>
          </div>

          <dl className="mt-10 grid max-w-xl grid-cols-3 gap-3">
            {heroStats.map((stat) => (
              <div key={stat.label} className="panel rounded p-4">
                <dt className="font-display text-2xl font-extrabold text-foreground">
                  {stat.value}
                </dt>
                <dd className="mt-1 text-xs leading-5 text-muted">{stat.label}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative">
          <OverviewPreview />
          <div className="absolute -bottom-8 -left-6 hidden lg:block">
            <MatchedCommentCard />
          </div>
        </div>
      </section>

      <section id="how" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-center">
          <div>
            <p className="label-mono text-sm font-bold text-accent">
              {t.home.howItWorksEyebrow}
            </p>
            <h2 className="mt-3 font-display text-4xl font-extrabold leading-tight text-foreground sm:text-5xl">
              {t.home.howItWorksTitle}
            </h2>
            <p className="mt-5 text-base leading-8 text-muted">{t.home.howItWorksBody}</p>
          </div>

          <div className="grid gap-4">
            {flowSteps.map((step) => (
              <article
                key={step.title}
                className="panel grid gap-4 rounded p-5 sm:grid-cols-[120px_1fr]"
              >
                <p className="label-mono text-xs font-bold text-accent">
                  {step.eyebrow}
                </p>
                <div>
                  <h3 className="text-xl font-bold text-foreground">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted">{step.description}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y-2 border-border bg-surface py-20">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 sm:px-6 lg:grid-cols-[1.08fr_0.92fr] lg:px-8 lg:items-center">
          <DashboardPreview />

          <div>
            <p className="label-mono text-sm font-bold text-accent">
              {t.home.dashboardEyebrow}
            </p>
            <h2 className="mt-3 font-display text-4xl font-extrabold leading-tight text-foreground sm:text-5xl">
              {t.home.dashboardTitle}
            </h2>
            <p className="mt-5 text-base leading-8 text-muted">{t.home.dashboardBody}</p>
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <p className="label-mono text-sm font-bold text-gold">
            {t.home.featuresEyebrow}
          </p>
          <h2 className="mt-3 font-display text-4xl font-extrabold leading-tight text-foreground sm:text-5xl">
            {t.home.featuresTitle}
          </h2>
          <p className="mt-5 text-base leading-8 text-muted">{t.home.featuresBody}</p>
        </div>

        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {t.home.features.map((feature) => (
            <div key={feature} className="panel rounded p-4 text-sm font-semibold text-foreground">
              {feature}
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-20 sm:px-6 lg:px-8">
        <div className="grid gap-8 rounded border-2 border-accent/30 bg-accent/10 p-6 sm:p-10 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <h2 className="max-w-3xl font-display text-4xl font-extrabold leading-tight text-foreground sm:text-5xl">
              {t.home.ctaTitle}
            </h2>
            <p className="mt-4 text-base text-muted">{t.home.ctaBody}</p>
          </div>
          <Link
            href="/login"
            className="label-mono inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3 text-xs font-bold text-background transition hover:bg-accent-hover"
          >
            {t.home.getStarted}
          </Link>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
