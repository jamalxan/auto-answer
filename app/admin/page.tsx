import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { getAdminOverview } from "@/lib/admin/data";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import LanguageSwitcher from "@/components/language-switcher";

export const metadata: Metadata = {
  title: "Admin - SocialAuto",
  robots: { index: false, follow: false },
};

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="panel rounded p-4">
      <p className="label-mono text-[11px] text-muted">{label}</p>
      <p className="font-display text-2xl font-extrabold text-foreground mt-1">
        {value.toLocaleString?.() ?? value}
      </p>
    </div>
  );
}

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  if (!isAdminEmail(session.user.email)) {
    notFound();
  }

  const [overview, locale] = await Promise.all([
    getAdminOverview(),
    getServerLocale(),
  ]);
  const t = dictionaries[locale].admin;

  const formatDate = (date: Date | null) =>
    date
      ? date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })
      : t.never;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b-2 border-border">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
          <Link href="/dashboard" className="flex items-center gap-3">
            <span className="font-display text-lg font-extrabold text-foreground">
              SocialAuto
            </span>
          </Link>
          <LanguageSwitcher />
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-8 px-5 py-8">
        <div>
          <h1 className="font-display text-2xl font-extrabold text-foreground">
            {t.title}
          </h1>
          <p className="mt-1 text-sm text-muted">{t.subtitle}</p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          <StatCard label={t.statWorkspaces} value={overview.totalWorkspaces} />
          <StatCard label={t.statUsers} value={overview.totalUsers} />
          <StatCard label={t.statInstagramAccounts} value={overview.totalInstagramAccounts} />
          <StatCard label={t.statActiveCampaigns} value={overview.activeAutomations} />
          <StatCard label={t.statDmsAllTime} value={overview.dmsSentAllTime} />
          <StatCard label={t.statDmsLast30Days} value={overview.dmsSentLast30Days} />
          <StatCard
            label={t.statNewWorkspaces30Days}
            value={overview.newWorkspacesLast30Days}
          />
        </div>

        <section className="panel rounded p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">
            {t.workspacesTitle}
          </h2>
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="label-mono text-left text-[11px] text-muted border-b border-border">
                  <th className="py-2 pr-4 font-medium">{t.colWorkspace}</th>
                  <th className="py-2 px-3 font-medium">{t.colOwner}</th>
                  <th className="py-2 px-3 font-medium">{t.colCreated}</th>
                  <th className="py-2 px-3 font-medium text-right">{t.colMembers}</th>
                  <th className="py-2 px-3 font-medium text-right">{t.colAccounts}</th>
                  <th className="py-2 px-3 font-medium text-right">{t.colCampaigns}</th>
                  <th className="py-2 px-3 font-medium text-right">{t.colDmsSent}</th>
                  <th className="py-2 px-3 font-medium text-right">{t.colDmsThisPeriod}</th>
                  <th className="py-2 pl-3 font-medium text-right">{t.colLastDm}</th>
                </tr>
              </thead>
              <tbody>
                {overview.workspaces.map((w) => (
                  <tr key={w.id} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4 text-foreground">{w.name}</td>
                    <td className="py-3 px-3 text-muted">{w.ownerEmail ?? t.noEmail}</td>
                    <td className="py-3 px-3 text-muted whitespace-nowrap">
                      {formatDate(w.createdAt)}
                    </td>
                    <td className="py-3 px-3 text-right text-muted">{w.memberCount}</td>
                    <td className="py-3 px-3 text-right text-muted">
                      {w.instagramAccountCount}
                    </td>
                    <td className="py-3 px-3 text-right text-muted">
                      {w.activeAutomationCount}/{w.automationCount}
                    </td>
                    <td className="py-3 px-3 text-right text-muted">{w.dmsSentAllTime}</td>
                    <td className="py-3 px-3 text-right text-muted">
                      {w.dmsSentThisPeriod}
                    </td>
                    <td className="py-3 pl-3 text-right text-muted whitespace-nowrap">
                      {formatDate(w.lastDmAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
