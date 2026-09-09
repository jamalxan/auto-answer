import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { getAdminOverview } from "@/lib/admin/data";
import { setWorkspaceSuspended, savePricingPlan, deletePricingPlan } from "@/lib/admin/actions";
import { getAllPricingPlans } from "@/lib/pricing";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import LanguageSwitcher from "@/components/language-switcher";
import AdminConfirmForm from "@/components/admin-confirm-form";

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

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  if (!isAdminEmail(session.user.email)) {
    notFound();
  }

  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const [overview, pricingPlans, locale] = await Promise.all([
    getAdminOverview({ query, page }),
    getAllPricingPlans(),
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
    return s ? `/admin?${s}` : "/admin";
  };

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
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              {t.workspacesTitle}
            </h2>
            <form action="/admin" method="get" className="flex gap-2">
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
                  href="/admin"
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
                    overview.page <= 1
                      ? "pointer-events-none opacity-40"
                      : "text-foreground"
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

        <section className="panel rounded p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground">{t.pricingTitle}</h2>
          <p className="mt-1 text-sm text-muted">{t.pricingSubtitle}</p>

          <div className="mt-5 space-y-4">
            {pricingPlans.map((plan) => (
              <div key={plan.id} className="rounded border-2 border-border p-4">
                <form action={savePricingPlan} className="grid gap-3 sm:grid-cols-6">
                  <input type="hidden" name="id" value={plan.id} />
                  <label className="text-xs text-muted sm:col-span-2">
                    {t.pricingFieldSlug}
                    <input
                      disabled
                      defaultValue={plan.slug}
                      className="mt-1 w-full rounded border-2 border-border bg-surface px-2 py-1.5 text-sm text-muted"
                    />
                  </label>
                  <label className="text-xs text-muted">
                    {t.pricingFieldPrice}
                    <input
                      type="number"
                      name="priceAmount"
                      defaultValue={plan.priceAmount}
                      className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                  </label>
                  <label className="text-xs text-muted">
                    {t.pricingFieldCurrency}
                    <input
                      name="priceCurrency"
                      defaultValue={plan.priceCurrency}
                      className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                  </label>
                  <label className="text-xs text-muted">
                    {t.pricingFieldSuffix}
                    <input
                      name="priceSuffix"
                      defaultValue={plan.priceSuffix}
                      className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                  </label>
                  <label className="text-xs text-muted">
                    {t.pricingFieldOrder}
                    <input
                      type="number"
                      name="sortOrder"
                      defaultValue={plan.sortOrder}
                      className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
                    />
                  </label>

                  <label className="flex items-center gap-2 text-xs text-muted sm:col-span-3">
                    <input type="checkbox" name="isFeatured" defaultChecked={plan.isFeatured} />
                    {t.pricingFieldFeatured}
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted sm:col-span-3">
                    <input type="checkbox" name="isActive" defaultChecked={plan.isActive} />
                    {t.pricingFieldActive}
                  </label>

                  <label className="text-xs text-muted sm:col-span-6">
                    {t.pricingFieldContent}
                    <textarea
                      name="content"
                      rows={8}
                      defaultValue={JSON.stringify(plan.content, null, 2)}
                      className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground focus:border-accent focus:outline-none"
                    />
                    <span className="mt-1 block text-[11px] text-muted">
                      {t.pricingContentHint}
                    </span>
                  </label>

                  <div className="flex gap-2 sm:col-span-6">
                    <button
                      type="submit"
                      className="label-mono rounded bg-accent px-4 py-1.5 text-xs font-bold text-background transition hover:bg-accent-hover"
                    >
                      {t.pricingSave}
                    </button>
                    <AdminConfirmForm
                      action={deletePricingPlan}
                      confirmMessage={t.pricingConfirmDelete}
                      label={t.pricingDelete}
                      hiddenFields={{ id: plan.id }}
                      className="label-mono rounded border-2 border-red-500/40 px-4 py-1.5 text-xs font-bold text-red-500 transition hover:bg-red-500/10"
                    />
                  </div>
                </form>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded border-2 border-dashed border-border p-4">
            <h3 className="text-xs font-bold text-foreground">{t.pricingAddTitle}</h3>
            <form action={savePricingPlan} className="mt-3 grid gap-3 sm:grid-cols-6">
              <label className="text-xs text-muted sm:col-span-2">
                {t.pricingFieldSlug}
                <input
                  name="slug"
                  placeholder={t.pricingNewSlugPlaceholder}
                  className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
                />
              </label>
              <label className="text-xs text-muted">
                {t.pricingFieldPrice}
                <input
                  type="number"
                  name="priceAmount"
                  defaultValue={0}
                  className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
                />
              </label>
              <label className="text-xs text-muted">
                {t.pricingFieldCurrency}
                <input
                  name="priceCurrency"
                  defaultValue="$"
                  className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
                />
              </label>
              <label className="text-xs text-muted">
                {t.pricingFieldSuffix}
                <input
                  name="priceSuffix"
                  defaultValue="/mo"
                  className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
                />
              </label>
              <label className="text-xs text-muted">
                {t.pricingFieldOrder}
                <input
                  type="number"
                  name="sortOrder"
                  defaultValue={pricingPlans.length}
                  className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
                />
              </label>

              <label className="text-xs text-muted sm:col-span-6">
                {t.pricingFieldContent}
                <textarea
                  name="content"
                  rows={8}
                  defaultValue={JSON.stringify(
                    {
                      en: { name: "", description: "", features: [] },
                      ru: { name: "", description: "", features: [] },
                      uz: { name: "", description: "", features: [] },
                    },
                    null,
                    2
                  )}
                  className="mt-1 w-full rounded border-2 border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground focus:border-accent focus:outline-none"
                />
                <span className="mt-1 block text-[11px] text-muted">
                  {t.pricingContentHint}
                </span>
              </label>

              <div className="sm:col-span-6">
                <button
                  type="submit"
                  className="label-mono rounded bg-accent px-4 py-1.5 text-xs font-bold text-background transition hover:bg-accent-hover"
                >
                  {t.pricingSave}
                </button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
