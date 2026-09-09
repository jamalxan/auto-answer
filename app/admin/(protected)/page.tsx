import type { Metadata } from "next";
import { getAdminStats } from "@/lib/admin/data";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";

export const metadata: Metadata = {
  title: "Admin",
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

export default async function AdminStatsPage() {
  const [stats, locale] = await Promise.all([getAdminStats(), getServerLocale()]);
  const t = dictionaries[locale].admin;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl font-extrabold text-foreground">{t.statsTitle}</h1>
        <p className="mt-1 text-sm text-muted">{t.statsSubtitle}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard label={t.statWorkspaces} value={stats.totalWorkspaces} />
        <StatCard label={t.statUsers} value={stats.totalUsers} />
        <StatCard label={t.statInstagramAccounts} value={stats.totalInstagramAccounts} />
        <StatCard label={t.statActiveCampaigns} value={stats.activeAutomations} />
        <StatCard label={t.statDmsAllTime} value={stats.dmsSentAllTime} />
        <StatCard label={t.statDmsLast30Days} value={stats.dmsSentLast30Days} />
        <StatCard label={t.statNewWorkspaces30Days} value={stats.newWorkspacesLast30Days} />
      </div>
    </div>
  );
}
