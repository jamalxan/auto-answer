"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import LogoMark from "@/components/logo-mark";
import { DevBadge } from "@/components/developer/ui";
import { developerLogoutAction } from "@/lib/developer/actions";

export interface DeveloperNavItem {
  href: string;
  label: string;
  etap?: number;
}

/**
 * Chrome for /developer: a slim header with the module nav. Deliberately
 * nothing like the customer dashboard shell, so it is always obvious which
 * side of the product you are looking at.
 */
export default function DeveloperShell({
  nav,
  workspaceName,
  children,
}: {
  nav: DeveloperNavItem[];
  workspaceName: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/developer" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/developer" className="flex min-w-0 items-center gap-2.5">
            <LogoMark />
            <span className="truncate font-display text-base font-extrabold tracking-tight">
              SocialAuto
            </span>
            <DevBadge />
          </Link>
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-xs text-muted sm:inline">{workspaceName}</span>
            <form action={developerLogoutAction}>
              <button type="submit" className="text-sm text-muted hover:text-foreground">
                Chiqish
              </button>
            </form>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2" aria-label="Modullar">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive(item.href)
                  ? "bg-surface text-foreground ring-1 ring-inset ring-border"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {item.etap !== undefined && (
                <span className="label-mono mr-1.5 text-[10px] text-muted">E{item.etap}</span>
              )}
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
