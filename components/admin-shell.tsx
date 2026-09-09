"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import LanguageSwitcher from "@/components/language-switcher";
import { adminLogoutAction } from "@/lib/admin/auth-actions";

interface AdminShellProps {
  labels: {
    navStats: string;
    navWorkspaces: string;
    navPricing: string;
    navSettings: string;
    navLogout: string;
  };
  children: React.ReactNode;
}

export default function AdminShell({ labels, children }: AdminShellProps) {
  const pathname = usePathname();

  const navLinks = [
    { href: "/admin", label: labels.navStats },
    { href: "/admin/workspaces", label: labels.navWorkspaces },
    { href: "/admin/pricing", label: labels.navPricing },
    { href: "/admin/settings", label: labels.navSettings },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b-2 border-border">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
          <div className="flex items-center gap-8">
            <Link href="/admin" className="flex items-center gap-3">
              <span className="font-display text-lg font-extrabold text-foreground">
                SocialAuto
              </span>
            </Link>
            <nav className="hidden items-center gap-1 sm:flex">
              {navLinks.map((link) => {
                const active =
                  link.href === "/admin" ? pathname === "/admin" : pathname.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`label-mono rounded px-3 py-2 text-xs font-bold transition ${
                      active
                        ? "bg-accent/10 text-accent"
                        : "text-muted hover:bg-surface-hover hover:text-foreground"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <form action={adminLogoutAction}>
              <button
                type="submit"
                className="label-mono rounded border-2 border-border px-3 py-1.5 text-xs font-bold text-foreground transition hover:border-border-hover hover:bg-surface-hover"
              >
                {labels.navLogout}
              </button>
            </form>
          </div>
        </div>
        {/* Mobile nav: same links, wrapped below the header row. */}
        <nav className="flex items-center gap-1 overflow-x-auto border-t border-border px-5 py-2 sm:hidden">
          {navLinks.map((link) => {
            const active =
              link.href === "/admin" ? pathname === "/admin" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`label-mono shrink-0 rounded px-3 py-1.5 text-xs font-bold transition ${
                  active ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-hover"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <div className="mx-auto max-w-7xl px-5 py-8">{children}</div>
    </div>
  );
}
