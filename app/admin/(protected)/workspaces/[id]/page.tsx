import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAdminWorkspaceDetail } from "@/lib/admin/overview";
import { setWorkspaceSuspended } from "@/lib/admin/actions";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { adminCopy, fmtDate, fmtDateTime, fmtMoney, fmtNumber, NETWORK_LABEL, planLabel } from "@/lib/admin/copy";
import { AdminTitle, NetworkMark, Panel, StatusPill } from "@/components/admin/parts";
import AdminConfirmForm from "@/components/admin-confirm-form";

export const metadata: Metadata = {
  title: "Customer - Admin",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function AdminWorkspaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [w, locale] = await Promise.all([getAdminWorkspaceDetail(id), getServerLocale()]);
  if (!w) notFound();
  const c = adminCopy(locale);
  const n = (v: number) => fmtNumber(v, locale);
  const paid = w.planSlug !== "start" && (!w.planExpiresAt || w.planExpiresAt > new Date());

  const stats: Array<{ label: string; value: string; unit?: string }> = [
    { label: c.statDms30, value: n(w.stats.dmsLast30) },
    { label: c.statDmsAll, value: n(w.stats.dmsAllTime) },
    { label: c.statCampaigns, value: `${n(w.stats.activeCampaigns)} / ${n(w.stats.campaigns)}` },
    { label: c.statPosts30, value: n(w.stats.postsLast30) },
    { label: c.statScheduled, value: n(w.stats.scheduledPosts) },
    { label: c.statRevenue, value: n(w.revenueAllTime), unit: "so'm" },
  ];

  return (
    <div className="space-y-6">
      <Link href="/admin/workspaces" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-white">
        ← {c.back}
      </Link>

      <AdminTitle
        title={w.name}
        sub={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatusPill tone={w.isSuspended ? "bad" : "ok"}>{w.isSuspended ? c.statusSuspended : c.statusActive}</StatusPill>
            <StatusPill tone={paid ? "ok" : "muted"}>
              {planLabel(w.planSlug)}
              {paid && w.planExpiresAt ? ` · ${c.planUntil(fmtDate(w.planExpiresAt, locale))}` : ""}
            </StatusPill>
            <span>
              {c.owner}: <span className="text-white">{w.owner.email ?? c.noEmail}</span>
            </span>
            <span>{c.since(fmtDate(w.createdAt, locale))}</span>
          </span>
        }
        actions={
          <AdminConfirmForm
            action={setWorkspaceSuspended}
            confirmMessage={w.isSuspended ? c.confirmReactivate : c.confirmSuspend}
            label={w.isSuspended ? c.reactivate : c.suspend}
            hiddenFields={{ workspaceId: w.id, suspend: w.isSuspended ? "false" : "true" }}
            className={`btn btn-sm ${w.isSuspended ? "btn-primary" : "btn-danger"}`}
          />
        }
      />

      {w.isSuspended && w.suspendedAt && <p className="rounded-2xl bg-error/12 px-4 py-3 text-sm text-error">{c.suspendedNotice(fmtDate(w.suspendedAt, locale))}</p>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {stats.map((s) => (
          <div key={s.label} className="panel min-w-0 rounded-3xl p-4">
            <p className="text-xs font-medium text-muted">{s.label}</p>
            <p className="display mt-2 text-lg tabular-nums text-white">
              {s.value}
              {s.unit && <span className="ml-1 font-sans text-xs font-semibold text-muted">{s.unit}</span>}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title={c.accountsTitle} className="xl:col-span-2">
          {w.accounts.length === 0 ? (
            <p className="inset px-4 py-8 text-center text-sm text-muted">{c.accountsEmpty}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {w.accounts.map((a, i) => (
                <li key={`${a.network}-${a.label}-${i}`} className="inset flex items-center gap-3 p-3">
                  <NetworkMark network={a.network} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-white">{a.label}</p>
                    <p className="text-xs text-muted">
                      {NETWORK_LABEL[a.network]} · {fmtDate(a.connectedAt, locale)}
                    </p>
                  </div>
                  <StatusPill tone={a.ok ? "ok" : "bad"}>{a.ok ? c.accountOk : c.accountBroken}</StatusPill>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={c.membersTitle}>
          <ul className="space-y-2">
            {w.members.map((m, i) => (
              <li key={`${m.email}-${i}`} className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet text-sm font-semibold text-white">{(m.name ?? m.email ?? "?").slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{m.name ?? m.email ?? c.noEmail}</p>
                  {m.name && m.email && <p className="truncate text-xs text-muted">{m.email}</p>}
                </div>
                <span className="shrink-0 text-xs text-muted">{c.roles[m.role] ?? m.role}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title={c.paymentsTitle}>
          {w.payments.length === 0 ? (
            <p className="inset px-4 py-8 text-center text-sm text-muted">{c.paymentsEmpty}</p>
          ) : (
            <ul className="divide-y divide-white/6">
              {w.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-white">
                      {planLabel(p.plan)} · {c.months(p.months)}
                    </p>
                    <p className="text-xs text-muted">
                      {p.provider} · {fmtDateTime(p.createdAt, locale)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular-nums text-white">{fmtMoney(p.amount, locale)}</p>
                    <StatusPill tone={p.status === "PAID" ? "ok" : p.status === "CANCELED" ? "bad" : "muted"}>{c.payStatus[p.status] ?? p.status}</StatusPill>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={c.errorsWsTitle}>
          {w.errors.length === 0 ? (
            <p className="inset px-4 py-8 text-center text-sm text-muted">{c.errorsEmpty}</p>
          ) : (
            <ul className="space-y-2">
              {w.errors.map((e) => (
                <li key={e.id} className="inset px-4 py-3">
                  <div className="flex justify-between gap-3 text-xs text-muted">
                    <span>{e.source}</span>
                    <span>{fmtDateTime(e.createdAt, locale)}</span>
                  </div>
                  <p className="mt-1 line-clamp-3 break-words text-sm text-cloud/85">{e.message}</p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
