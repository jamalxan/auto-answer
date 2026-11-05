import type { Metadata } from "next";
import Link from "next/link";
import { getAdminWorkspaces, type AdminWorkspaceFilter } from "@/lib/admin/data";
import { NETWORKS } from "@/lib/admin/overview";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { adminCopy, fmtDate, fmtNumber, planLabel } from "@/lib/admin/copy";
import { AdminTitle, NetworkMark, StatusPill } from "@/components/admin/parts";

export const metadata: Metadata = {
  title: "Customers - Admin",
  robots: { index: false, follow: false },
};

const FILTERS: AdminWorkspaceFilter[] = ["all", "paying", "new", "suspended"];

export default async function AdminWorkspacesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; f?: string }> }) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);
  const filter: AdminWorkspaceFilter = FILTERS.includes(params.f as AdminWorkspaceFilter) ? (params.f as AdminWorkspaceFilter) : "all";

  const [overview, locale] = await Promise.all([getAdminWorkspaces({ query, page, filter }), getServerLocale()]);
  const c = adminCopy(locale);
  const n = (v: number) => fmtNumber(v, locale);
  const filterLabel: Record<AdminWorkspaceFilter, string> = { all: c.filterAll, paying: c.filterPaying, new: c.filterNew, suspended: c.filterSuspended };

  const href = (next: { page?: number; f?: AdminWorkspaceFilter }) => {
    const qs = new URLSearchParams();
    if (query) qs.set("q", query);
    const f = next.f ?? filter;
    if (f !== "all") qs.set("f", f);
    const p = next.page ?? 1;
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return s ? `/admin/workspaces?${s}` : "/admin/workspaces";
  };

  return (
    <div className="space-y-6">
      <AdminTitle title={c.customersTitle} sub={c.customersSub(overview.matchingWorkspaces)} />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Link key={f} href={href({ f })} className={`chip ${f === filter ? "chip-active" : ""}`} aria-current={f === filter ? "true" : undefined}>
              {filterLabel[f]}
            </Link>
          ))}
        </div>
        <form action="/admin/workspaces" method="get" className="flex gap-2">
          {filter !== "all" && <input type="hidden" name="f" value={filter} />}
          <input type="search" name="q" defaultValue={query} placeholder={c.searchPlaceholder} aria-label={c.searchPlaceholder} className="input min-w-0 flex-1 !bg-surface lg:w-80" />
          <button type="submit" className="btn btn-sm btn-primary">
            {c.search}
          </button>
          {query && (
            <Link href={href({})} className="btn btn-sm btn-ghost">
              {c.clear}
            </Link>
          )}
        </form>
      </div>

      {overview.workspaces.length === 0 ? (
        <div className="panel rounded-3xl px-6 py-14 text-center">
          <p className="text-base font-bold text-white">{c.empty}</p>
          <p className="mt-2 text-sm text-muted">{c.emptyBody}</p>
        </div>
      ) : (
        <>
          {/* Phones: one card per customer. */}
          <ul className="space-y-3 md:hidden">
            {overview.workspaces.map((w) => (
              <li key={w.id}>
                <Link href={`/admin/workspaces/${w.id}`} className="panel block rounded-3xl p-4 hover:bg-surface-hover">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-white">{w.name}</p>
                      <p className="truncate text-xs text-muted">{w.ownerEmail ?? c.noEmail}</p>
                    </div>
                    <StatusPill tone={w.isSuspended ? "bad" : w.planSlug === "start" ? "muted" : "ok"}>{w.isSuspended ? c.statusSuspended : planLabel(w.planSlug)}</StatusPill>
                  </div>
                  <div className="mt-3 flex items-center gap-1.5">
                    {NETWORKS.filter((net) => (w.networkCounts[net] ?? 0) > 0).map((net) => (
                      <NetworkMark key={net} network={net} size="sm" />
                    ))}
                    <span className="ml-auto text-xs text-muted">
                      {c.colDms}: <span className="font-semibold text-white">{n(w.dmsSentThisPeriod)}</span>
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* md and up: a table, every row opens the customer. */}
          <div className="panel hidden overflow-hidden rounded-3xl md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="px-5 py-4 font-semibold">{c.colCustomer}</th>
                  <th className="px-3 py-4 font-semibold">{c.colPlan}</th>
                  <th className="px-3 py-4 font-semibold">{c.colAccounts}</th>
                  <th className="px-3 py-4 text-right font-semibold">{c.colCampaigns}</th>
                  <th className="px-3 py-4 text-right font-semibold">{c.colDms}</th>
                  <th className="hidden px-3 py-4 font-semibold lg:table-cell">{c.colLastActivity}</th>
                  <th className="hidden px-3 py-4 font-semibold xl:table-cell">{c.colCreated}</th>
                  <th className="px-5 py-4 text-right font-semibold">
                    <span className="sr-only">{c.open}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.workspaces.map((w) => {
                  const nets = NETWORKS.filter((net) => (w.networkCounts[net] ?? 0) > 0);
                  return (
                    <tr key={w.id} className="border-t border-white/6 transition-colors hover:bg-surface-hover">
                      <td className="max-w-[18rem] px-5 py-3.5">
                        <Link href={`/admin/workspaces/${w.id}`} className="block min-w-0">
                          <span className="block truncate font-semibold text-white">{w.name}</span>
                          <span className="block truncate text-xs text-muted">{w.ownerEmail ?? c.noEmail}</span>
                        </Link>
                      </td>
                      <td className="px-3 py-3.5">
                        <StatusPill tone={w.isSuspended ? "bad" : w.planSlug === "start" ? "muted" : "ok"}>{w.isSuspended ? c.statusSuspended : planLabel(w.planSlug)}</StatusPill>
                      </td>
                      <td className="px-3 py-3.5">
                        {nets.length === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span className="flex items-center gap-1">
                            {nets.map((net) => (
                              <NetworkMark key={net} network={net} size="sm" />
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-3.5 text-right tabular-nums text-cloud/85">
                        {w.activeAutomationCount}
                        <span className="text-muted">/{w.automationCount}</span>
                      </td>
                      <td className="px-3 py-3.5 text-right tabular-nums text-cloud/85">{n(w.dmsSentThisPeriod)}</td>
                      <td className="hidden whitespace-nowrap px-3 py-3.5 text-muted lg:table-cell">{w.lastDmAt ? fmtDate(w.lastDmAt, locale) : c.never}</td>
                      <td className="hidden whitespace-nowrap px-3 py-3.5 text-muted xl:table-cell">{fmtDate(w.createdAt, locale)}</td>
                      <td className="px-5 py-3.5 text-right">
                        <Link href={`/admin/workspaces/${w.id}`} className="btn btn-sm btn-ghost">
                          {c.open}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {overview.pageCount > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">{c.pageOf(overview.page, overview.pageCount)}</span>
          <div className="flex gap-2">
            <Link href={href({ page: overview.page - 1 })} aria-disabled={overview.page <= 1} className={`btn btn-sm btn-ghost ${overview.page <= 1 ? "pointer-events-none opacity-40" : ""}`}>
              {c.prev}
            </Link>
            <Link href={href({ page: overview.page + 1 })} aria-disabled={overview.page >= overview.pageCount} className={`btn btn-sm btn-ghost ${overview.page >= overview.pageCount ? "pointer-events-none opacity-40" : ""}`}>
              {c.next}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
