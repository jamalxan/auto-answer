"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import Icon from "@/components/ui/Icon";
import { clearToken, getAccounts, type Account } from "@/lib/api";

const NAV = [
  { href: "/dashboard", label: "Panel", icon: "panel" },
  { href: "/campaigns", label: "Kampaniyalar", icon: "funnel" },
  { href: "/logs", label: "Jurnal", icon: "log" },
  { href: "/leads", label: "Lidlar", icon: "lead" },
  { href: "/accounts", label: "Akkountlar", icon: "jack" },
];

export default function Shell({
  title,
  crumb,
  actions,
  children,
}: {
  title: string;
  crumb?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const path = usePathname();
  const router = useRouter();
  const active = (h: string) => path === h || path.startsWith(h + "/");

  const [account, setAccount] = useState<Account | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getAccounts()
      .then((accs) => {
        if (!cancelled) setAccount(accs[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setAccount(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tokenDaysLeft = account?.token_expires_at
    ? Math.max(0, Math.ceil((new Date(account.token_expires_at).getTime() - Date.now()) / 86400000))
    : null;

  function logout() {
    clearToken();
    router.replace("/login");
  }

  return (
    <div className="min-h-svh grain" style={{ background: "var(--c-field)" }}>
      {/* ── left rail (desktop) ── */}
      <aside
        className="hidden lg:flex fixed inset-y-0 left-0 w-[var(--rail-w)] flex-col border-r"
        style={{ background: "var(--c-field-deep)", borderColor: "var(--c-line)" }}
      >
        <Link href="/" className="flex items-center gap-2 px-5 h-16 shrink-0">
          <span
            className="util px-2 py-1"
            style={{ background: "var(--c-paper)", color: "var(--c-field-deep)" }}
          >
            IGDM
          </span>
          <span className="util text-paper/45">v1.0</span>
        </Link>

        <nav className="px-3 py-2 space-y-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active(n.href) ? "page" : undefined}
              className="flex items-center gap-3 px-3 min-h-[44px] rounded-bay transition-colors duration-200"
              style={
                active(n.href)
                  ? { background: "var(--c-signal)", color: "var(--c-field-deep)" }
                  : { color: "var(--c-paper)" }
              }
            >
              <Icon name={n.icon} size={18} />
              <span className="util">{n.label}</span>
            </Link>
          ))}
        </nav>

        <div className="mt-auto p-3">
          <Link
            href="/settings"
            className="flex items-center gap-3 px-3 min-h-[44px] rounded-bay"
            style={
              active("/settings")
                ? { background: "var(--c-signal)", color: "var(--c-field-deep)" }
                : { color: "var(--c-paper)" }
            }
          >
            <Icon name="gear" size={18} />
            <span className="util">Sozlamalar</span>
          </Link>
          <button
            type="button"
            onClick={logout}
            className="flex items-center gap-3 px-3 min-h-[44px] rounded-bay w-full text-left"
            style={{ color: "var(--c-paper)" }}
          >
            <Icon name="power" size={18} />
            <span className="util">Chiqish</span>
          </button>
          <p className="util px-3 pt-4 pb-1 text-paper/40">ulangan akkount</p>
          <p className="px-3 pb-3 text-[15px] truncate">
            {account === undefined ? "…" : account ? `@${account.ig_username}` : "ulanmagan"}
          </p>
        </div>
      </aside>

      {/* ── main column ── */}
      <div className="lg:pl-[var(--rail-w)]">
        <header
          className="sticky top-0 z-30 border-b backdrop-blur"
          style={{ background: "rgba(12,13,63,.86)", borderColor: "var(--c-line)" }}
        >
          <div className="flex items-center gap-3 px-4 md:px-6 h-16">
            <div className="min-w-0">
              {crumb && <p className="util text-saffron truncate">{crumb}</p>}
              <h1 className="font-display text-b-1 leading-tight truncate">{title}</h1>
            </div>
            <div className="ml-auto flex items-center gap-2">{actions}</div>
          </div>

          {/* the ticker: real account state, no fabricated numbers */}
          <div
            className="util flex items-center gap-4 px-4 md:px-6 py-1.5 border-t overflow-x-auto whitespace-nowrap"
            style={{ borderColor: "var(--c-line)", color: "var(--c-paper)" }}
          >
            {account === undefined ? (
              <span className="text-paper/45">yuklanmoqda…</span>
            ) : account === null ? (
              <Link href="/accounts" className="hover:underline" style={{ color: "var(--c-wrong)" }}>
                Instagram akkounti ulanmagan — ulash
              </Link>
            ) : (
              <>
                <span className="flex items-center gap-1.5" style={{ color: account.webhook_subscribed ? "var(--c-wrong)" : "var(--c-madder)" }}>
                  <span
                    className="w-1.5 h-1.5 rounded-jack animate-pulse"
                    style={{ background: account.webhook_subscribed ? "var(--c-wrong)" : "var(--c-madder)" }}
                    aria-hidden
                  />
                  {account.webhook_subscribed ? "webhook faol" : "webhook ulanmagan"}
                </span>
                {tokenDaysLeft !== null && (
                  <span style={{ color: tokenDaysLeft <= 7 ? "var(--c-madder)" : "var(--c-saffron)" }}>
                    token {tokenDaysLeft} kundan keyin tugaydi
                  </span>
                )}
              </>
            )}
          </div>
        </header>

        <main id="main" className="px-4 md:px-6 py-6 pb-28 lg:pb-10 max-w-[1400px]">
          {children}
        </main>
      </div>

      {/* ── bottom nav (mobile), 5 items, 44px targets ── */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 grid grid-cols-5 border-t"
        style={{ background: "var(--c-field-deep)", borderColor: "var(--c-line)" }}
      >
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active(n.href) ? "page" : undefined}
            className="flex flex-col items-center justify-center gap-1 min-h-[56px] px-1"
            style={{ color: active(n.href) ? "var(--c-signal)" : "var(--c-paper)" }}
          >
            <Icon name={n.icon} size={20} />
            <span className="util text-[9px] tracking-[0.08em]">{n.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
