"use client";

/**
 * Platform-admin frame: the same sidebar language as the customer dashboard
 * (solid surface, filled violet pill for the active item), with an "Admin"
 * tag so the owner never mistakes this for a customer workspace. Below lg the
 * sidebar is a drawer behind a menu button.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Icon, { type IconName } from "@/components/icons";
import { Wordmark } from "@/components/logo-mark";
import LanguageSwitcher from "@/components/language-switcher";
import { adminLogoutAction } from "@/lib/admin/auth-actions";

export interface AdminShellLabels {
  badge: string;
  navOverview: string;
  navCustomers: string;
  navPricing: string;
  navSettings: string;
  logout: string;
  openMenu: string;
  closeMenu: string;
  signedInAs: string;
}

export default function AdminShell({
  labels,
  admin,
  children,
}: {
  labels: AdminShellLabels;
  admin: { username: string; email: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const nav: Array<{ href: string; label: string; icon: IconName }> = [
    { href: "/admin", label: labels.navOverview, icon: "home" },
    { href: "/admin/workspaces", label: labels.navCustomers, icon: "users" },
    { href: "/admin/pricing", label: labels.navPricing, icon: "list" },
    { href: "/admin/settings", label: labels.navSettings, icon: "settings" },
  ];
  const isActive = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(href + "/"));

  // The drawer closes on navigation and on Escape.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- route change closes the drawer
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <div
        className={`fixed inset-0 z-40 bg-midnight/75 transition-opacity duration-200 lg:hidden ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <aside
        className={`fixed left-0 top-0 z-50 flex h-dvh w-64 max-w-[85vw] shrink-0 flex-col bg-surface transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] lg:sticky lg:translate-x-0 ${
          open ? "translate-x-0 shadow-float" : "-translate-x-full max-lg:invisible"
        }`}
      >
        <div className="flex items-center justify-between gap-2 px-5 pb-6 pt-5">
          <Link href="/admin" className="inline-flex items-center gap-2.5" aria-label="SocialAuto Admin">
            <Wordmark markClassName="h-8 w-8" textClassName="text-[1.15rem]" />
            <span className="rounded-full bg-lime px-2 py-0.5 text-[11px] font-bold text-midnight">{labels.badge}</span>
          </Link>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-hover hover:text-white lg:hidden"
            aria-label={labels.closeMenu}
          >
            <Icon name="close" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3">
          <ul className="space-y-1">
            {nav.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`group flex items-center gap-3 rounded-full px-3.5 py-2.5 text-[15px] font-medium ${
                      active ? "bg-violet text-white" : "text-muted hover:bg-surface-hover hover:text-white"
                    }`}
                  >
                    <Icon name={item.icon} className={`h-[18px] w-[18px] shrink-0 ${active ? "text-white" : "text-muted group-hover:text-white"}`} />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between px-2">
            <LanguageSwitcher />
          </div>
          <div className="inset rounded-2xl p-3">
            <p className="text-xs text-muted">{labels.signedInAs}</p>
            <p className="mt-0.5 truncate text-sm font-semibold text-white">{admin.username}</p>
            <p className="truncate text-xs text-muted">{admin.email}</p>
            <form action={adminLogoutAction} className="mt-3">
              <button type="submit" className="btn btn-sm btn-ghost w-full">
                <Icon name="logout" className="h-4 w-4" />
                {labels.logout}
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 bg-background/95 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="grid h-10 w-10 place-items-center rounded-full text-white hover:bg-surface-hover"
            aria-label={labels.openMenu}
            aria-expanded={open}
          >
            <Icon name="menu" />
          </button>
          <Wordmark markClassName="h-7 w-7" textClassName="text-[1.05rem]" />
          <span className="rounded-full bg-lime px-2 py-0.5 text-[11px] font-bold text-midnight">{labels.badge}</span>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-10">{children}</main>
      </div>
    </div>
  );
}
