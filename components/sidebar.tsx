"use client";

/**
 * Sidebar Navigation
 *
 * Text-only nav with active state and workspace section.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import LanguageSwitcher from "@/components/language-switcher";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
}

export default function Sidebar({
  isOpen,
  onClose,
  workspaceName,
}: SidebarProps) {
  const pathname = usePathname();
  const { t } = useLanguage();

  const navItems = [
    { label: t.nav.dashboard, href: "/dashboard" },
    { label: t.nav.overview, href: "/overview" },
    { label: t.nav.inbox, href: "/inbox" },
    { label: t.nav.campaigns, href: "/campaigns" },
    { label: t.nav.dmLogs, href: "/logs" },
    { label: t.nav.settings, href: "/settings" },
    { label: t.nav.diagnostics, href: "/diagnostics" },
  ];

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          fixed top-0 left-0 z-50 h-dvh w-64 max-w-[85vw] shrink-0 bg-surface border-r-2 border-border flex flex-col
          transition-transform duration-200 ease-out
          lg:h-full lg:translate-x-0 lg:static lg:z-auto
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
      >
        {/* Same reason as the top bar: the drawer is full height, so the
            wordmark would otherwise land under the status bar. */}
        <div
          className="px-6 py-5 border-b-2 border-border"
          style={{ paddingTop: "calc(1.25rem + env(safe-area-inset-top))" }}
        >
          <Link
            href="/dashboard"
            className="font-display text-lg font-extrabold tracking-tight text-foreground"
          >
            SocialAuto
          </Link>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                aria-current={isActive ? "page" : undefined}
                className={`
                  label-mono block px-3 py-2.5 rounded text-xs
                  ${
                    isActive
                      ? "bg-surface-hover text-accent font-bold"
                      : "text-muted hover:text-foreground hover:bg-surface-hover"
                  }
                `}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t-2 border-border">
          <p className="min-w-0 truncate text-sm text-foreground">{workspaceName}</p>
          <LanguageSwitcher />
        </div>
      </aside>
    </>
  );
}
