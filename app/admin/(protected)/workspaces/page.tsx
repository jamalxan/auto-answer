import type { Metadata } from "next";
import Link from "next/link";
import { getAdminWorkspaces } from "@/lib/admin/data";
import { setWorkspaceSuspended } from "@/lib/admin/actions";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import AdminConfirmForm from "@/components/admin-confirm-form";

export const metadata: Metadata = {
  title: "Workspaces - Admin",
  robots: { index: false, follow: false },
};

export default async function AdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const [overview, locale] = await Promise.all([
    getAdminWorkspaces({ query, page }),
    getServerLocale(),
  ]);
  const t = dictionaries[locale].admin;

  const formatDate = (date: Date | null) =>
    date
      ? date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })
      : t.never;

  const pageHref = (targetPage: number) => {
    const qs = new URLSearchParams();
    if (query) qs.set("q", query);
    if (targetPage > 1) qs.set("page", String(targetPage));
    const s = qs.toString();
    return s ? `/admin/workspaces?${s}` : "/admin/workspaces";
  };

  return (
    <section className="panel rounded p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-xl font-extrabold text-foreground">
          {t.workspacesTitle}
        </h1>
        <form action="/admin/workspaces" method="get" className="flex gap-2">
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder={t.searchPlaceholder}
            className="w-full min-w-[220px] rounded border-2 border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none sm:w-72"
          />
          <button
            type="submit"
            className="label-mono rounded border-2 border-border px-3 py-1.5 text-xs font-bold text-foreground transition hover:border-border-hover hover:bg-surface-hover"
          >
            {t.searchButton}
          </button>
          {query && (
            <Link
              href="/admin/workspaces"
              className="label-mono flex items-center rounded border-2 border-border px-3 py-1.5 text-xs font-bold text-muted transition hover:border-border-hover hover:bg-surface-hover"
            >
              {t.clearSearch}
            </Link>
          )}
        </form>
      </div>

      {overview.workspaces.length === 0 ? (
        <p className="mt-6 text-sm text-muted">{t.noResults}</p>
      ) : (
        <div className="-mx-4 mt-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[980px] text-sm">
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
                <th className="py-2 px-3 font-medium text-right">{t.colLastDm}</th>
                <th className="py-2 px-3 font-medium">{t.colStatus}</th>
                <th className="py-2 pl-3 font-medium text-right">{t.colAction}</th>
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
                  <td className="py-3 px-3 text-right text-muted">{w.instagramAccountCount}</td>
                  <td className="py-3 px-3 text-right text-muted">
                    {w.activeAutomationCount}/{w.automationCount}
                  </td>
                  <td className="py-3 px-3 text-right text-muted">{w.dmsSentAllTime}</td>
                  <td className="py-3 px-3 text-right text-muted">{w.dmsSentThisPeriod}</td>
                  <td className="py-3 px-3 text-right text-muted whitespace-nowrap">
                    {formatDate(w.lastDmAt)}
                  </td>
                  <td className="py-3 px-3 whitespace-nowrap">
                    <span
                      className={`label-mono inline-flex items-center rounded border-2 px-2 py-0.5 text-[10px] font-bold ${
                        w.isSuspended
                          ? "border-red-500/40 bg-red-500/10 text-red-500"
                          : "border-emerald-500/40 bg-emerald-500/10 text-emerald-500"
                      }`}
                    >
                      {w.isSuspended ? t.statusSuspended : t.statusActive}
                    </span>
                  </td>
                  <td className="py-3 pl-3 text-right whitespace-nowrap">
                    <AdminConfirmForm
                      action={setWorkspaceSuspended}
                      confirmMessage={w.isSuspended ? t.confirmReactivate : t.confirmSuspend}
                      label={w.isSuspended ? t.actionReactivate : t.actionSuspend}
                      hiddenFields={{
                        workspaceId: w.id,
                        suspend: w.isSuspended ? "false" : "true",
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {overview.pageCount > 1 && (
        <div className="mt-5 flex items-center justify-between">
          <span className="label-mono text-[11px] text-muted">
            {t.pageOf(overview.page, overview.pageCount)}
          </span>
          <div className="flex gap-2">
            <Link
              href={pageHref(overview.page - 1)}
              aria-disabled={overview.page <= 1}
              className={`label-mono rounded border-2 border-border px-3 py-1.5 text-xs font-bold transition hover:border-border-hover hover:bg-surface-hover ${
                overview.page <= 1 ? "pointer-events-none opacity-40" : "text-foreground"
              }`}
            >
              {t.prevPage}
            </Link>
            <Link
              href={pageHref(overview.page + 1)}
              aria-disabled={overview.page >= overview.pageCount}
              className={`label-mono rounded border-2 border-border px-3 py-1.5 text-xs font-bold transition hover:border-border-hover hover:bg-surface-hover ${
                overview.page >= overview.pageCount
                  ? "pointer-events-none opacity-40"
                  : "text-foreground"
              }`}
            >
              {t.nextPage}
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
