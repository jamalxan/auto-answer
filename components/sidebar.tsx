"use client";

/**
 * Sidebar Navigation
 *
 * Icon + label nav, grouped by area, with active state and workspace footer.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import Icon, { type IconName } from "@/components/icons";
import LogoMark from "@/components/logo-mark";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
  isAdmin?: boolean;
}

interface NavItem {
  label: string;
  href: string;
  icon: IconName;
}

export default function Sidebar({
  isOpen,
  onClose,
  workspaceName,
  isAdmin = false,
}: SidebarProps) {
  const pathname = usePathname();
  const { t } = useLanguage();

  // Groups are separated visually only, so no extra translated headings.
  const navGroups: NavItem[][] = [
    [
      { label: t.nav.dashboard, href: "/dashboard", icon: "home" },
      { label: t.nav.overview, href: "/overview", icon: "chart" },
      { label: t.nav.inbox, href: "/inbox", icon: "inbox" },
      { label: t.nav.campaigns, href: "/campaigns", icon: "megaphone" },
    ],
    [
      { label: t.assistant.nav.assistant, href: "/assistant", icon: "sparkles" },
      { label: t.assistant.nav.leads, href: "/leads", icon: "users" },
      { label: t.assistant.nav.integrations, href: "/integrations", icon: "plug" },
    ],
    [
      { label: t.nav.dmLogs, href: "/logs", icon: "list" },
      { label: t.nav.settings, href: "/settings", icon: "settings" },
      { label: t.nav.diagnostics, href: "/diagnostics", icon: "activity" },
      ...(isAdmin
        ? [{ label: t.admin.navLabel, href: "/admin", icon: "shield" as const }]
        : []),
    ],
  ];

  const initial = workspaceName.trim().charAt(0).toUpperCase() || "S";

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200 lg:hidden ${
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        className={`
          fixed top-0 left-0 z-50 h-dvh w-64 max-w-[85vw] shrink-0 flex flex-col
          border-r border-border bg-surface/95 backdrop-blur-xl lg:bg-surface/60
          transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]
          lg:h-full lg:translate-x-0 lg:static lg:z-auto
          ${isOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"}
        `}
      >
        {/* Same reason as the top bar: the drawer is full height, so the
            wordmark would otherwise land under the status bar. */}
        <div
          className="flex items-center justify-between gap-2 px-5 pb-4"
          style={{ paddingTop: "calc(1.25rem + env(safe-area-inset-top))" }}
        >
          <Link href="/dashboard" className="group flex items-center gap-2.5">
            <LogoMark />
            <span className="font-display text-base font-extrabold tracking-tight text-foreground">
              SocialAuto
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-surface-hover hover:text-foreground lg:hidden"
            aria-label="Close menu"
          >
            <Icon name="close" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {navGroups.map((group, i) => (
            <div
              key={i}
              className={i > 0 ? "mt-3 border-t border-border pt-3" : ""}
            >
              <ul className="space-y-0.5">
                {group.map((item) => {
                  const isActive =
                    pathname === item.href || pathname.startsWith(item.href + "/");
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onClose}
                        aria-current={isActive ? "page" : undefined}
                        className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
                          isActive
                            ? "bg-accent/10 text-foreground"
                            : "text-muted hover:bg-surface-hover hover:text-foreground"
                        }`}
                      >
                        {isActive && (
                          <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />
                        )}
                        <Icon
                          name={item.icon}
                          className={`h-[18px] w-[18px] shrink-0 ${
                            isActive ? "text-accent" : "text-muted group-hover:text-foreground"
                          }`}
                        />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-border p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-hover text-sm font-bold text-foreground ring-1 ring-border">
              {initial}
            </span>
            <p className="min-w-0 truncate text-sm font-medium text-foreground">
              {workspaceName}
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
