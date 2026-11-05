import type { Metadata } from "next";
import Link from "next/link";
import { getAdminOverview } from "@/lib/admin/overview";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { adminCopy, fmtDate, fmtDateTime, fmtNumber, NETWORK_LABEL, planLabel } from "@/lib/admin/copy";
import { ActivityChart, AdminTitle, Kpi, NetworkMark, Panel, StatusPill } from "@/components/admin/parts";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const [o, locale] = await Promise.all([getAdminOverview(), getServerLocale()]);
  const c = adminCopy(locale);
  const n = (v: number) => fmtNumber(v, locale);
  const healthy = o.health.failedDms24h === 0 && o.health.failedPosts7d === 0 && o.health.errors24h === 0 && o.health.brokenAccounts === 0;
  const maxPlan = Math.max(1, ...o.plans.map((p) => p.count));

  const healthRows = [
    { label: c.healthFailedDms, value: o.health.failedDms24h },
    { label: c.healthFailedPosts, value: o.health.failedPosts7d },
    { label: c.healthErrors, value: o.health.errors24h },
    { label: c.healthBroken, value: o.health.brokenAccounts },
  ];

  return (
    <div className="space-y-6">
      <AdminTitle title={c.overviewTitle} sub={c.overviewSub(fmtDateTime(o.generatedAt, locale))} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi tone="lime" label={c.kpiRevenue} value={fmtNumber(o.revenueLast30.current, locale)} unit="so'm" trend={o.revenueLast30} vsLabel={c.vsPrev} noPrevLabel={c.noPrev} />
        <Kpi
          label={c.kpiCustomers}
          value={n(o.workspaces.total)}
          foot={
            <>
              {c.kpiPaying}: <span className="font-semibold text-white">{n(o.workspaces.paying)}</span> · {c.usersLine(o.users)}
              {o.workspaces.suspended > 0 ? ` · ${c.suspendedLine(o.workspaces.suspended)}` : ""}
            </>
          }
        />
        <Kpi label={c.kpiNew} value={n(o.workspaces.newLast30.current)} trend={o.workspaces.newLast30} vsLabel={c.vsPrev} noPrevLabel={c.noPrev} />
        <Kpi label={c.kpiDms} value={n(o.dmsLast30.current)} trend={o.dmsLast30} vsLabel={c.vsPrev} noPrevLabel={c.noPrev} foot={c.campaignsLine(o.activeCampaigns)} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title={c.activityTitle} sub={c.activitySub} className="xl:col-span-2">
          <ActivityChart data={o.daily} dmsLabel={c.legendDms} signupsLabel={c.legendSignups} emptyLabel={c.noActivity} locale={locale} />
        </Panel>

        <Panel
          title={c.healthTitle}
          action={<StatusPill tone={healthy ? "ok" : "warn"}>{healthy ? c.healthOk : c.healthAttention}</StatusPill>}
        >
          <ul className="space-y-2">
            {healthRows.map((r) => (
              <li key={r.label} className="inset flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm text-cloud/85">{r.label}</span>
                <span className={`display text-lg tabular-nums ${r.value > 0 ? "text-error" : "text-white"}`}>{n(r.value)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title={c.networksTitle} sub={c.networksSub} className="xl:col-span-2">
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {o.networks.map((net) => (
              <li key={net.network} className="inset flex items-center gap-3 p-4">
                <NetworkMark network={net.network} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{NETWORK_LABEL[net.network]}</p>
                  <p className="text-xs text-muted">{net.connected > 0 ? c.networkConnected(net.connected) : c.networkNone}</p>
                  {net.broken > 0 && <p className="text-xs font-medium text-error">{c.networkBroken(net.broken)}</p>}
                </div>
                <span className="display ml-auto text-xl tabular-nums text-white">{n(net.connected)}</span>
              </li>
            ))}
            <li className="inset flex items-center justify-between gap-3 p-4">
              <span className="text-sm text-muted">{c.kpiPosts}</span>
              <span className="display text-xl tabular-nums text-white">{n(o.postsLast30.current)}</span>
            </li>
          </ul>
        </Panel>

        <Panel title={c.plansTitle}>
          <ul className="space-y-3">
            {o.plans.map((p) => (
              <li key={p.slug}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-white">{planLabel(p.slug)}</span>
                  <span className="tabular-nums text-muted">{n(p.count)}</span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-midnight">
                  <div className={`h-full rounded-full ${p.slug === "start" ? "bg-white/25" : "bg-lime"}`} style={{ width: `${(p.count / maxPlan) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title={c.recentTitle}
          action={
            <Link href="/admin/workspaces" className="text-sm font-semibold text-lime hover:underline">
              {c.allCustomers} →
            </Link>
          }
        >
          <ul className="divide-y divide-white/6">
            {o.recentWorkspaces.map((w) => (
              <li key={w.id}>
                <Link href={`/admin/workspaces/${w.id}`} className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 hover:bg-surface-hover">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet text-sm font-semibold text-white">{w.name.slice(0, 1).toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-white">{w.name}</p>
                    <p className="truncate text-xs text-muted">{w.ownerEmail ?? c.noEmail}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <StatusPill tone={w.isSuspended ? "bad" : w.planSlug === "start" ? "muted" : "ok"}>{w.isSuspended ? c.statusSuspended : planLabel(w.planSlug)}</StatusPill>
                    <p className="mt-1 text-[11px] text-muted">{fmtDate(w.createdAt, locale)}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title={c.errorsTitle}>
          {o.recentErrors.length === 0 ? (
            <p className="inset px-4 py-8 text-center text-sm text-muted">{c.errorsEmpty}</p>
          ) : (
            <ul className="space-y-2">
              {o.recentErrors.map((e) => (
                <li key={e.id} className="inset px-4 py-3">
                  <div className="flex items-center justify-between gap-3 text-xs text-muted">
                    <span className="truncate">
                      {e.workspaceId ? (
                        <Link href={`/admin/workspaces/${e.workspaceId}`} className="font-semibold text-white hover:underline">
                          {e.workspaceName}
                        </Link>
                      ) : (
                        e.source
                      )}
                    </span>
                    <span className="shrink-0">{fmtDateTime(e.createdAt, locale)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 break-words text-sm text-cloud/85">{e.message}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
