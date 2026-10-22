"use client";

/**
 * Sidebar Navigation
 *
 * Icon + label nav, grouped by area, with active state and workspace footer.
 * One solid surface, a tone step up from the canvas; the active item is a
 * filled violet pill.
 */

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import Icon, { type IconName } from "@/components/icons";
import { Wordmark } from "@/components/logo-mark";
import { signOutAction } from "@/lib/auth-actions";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceName: string;
  userEmail?: string | null;
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
  userEmail = null,
  isAdmin = false,
}: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useLanguage();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const accountMenuId = useId();

  // The account menu is the only popover in the shell, so a small local
  // outside-click / Escape handler beats pulling in a menu library. A tap on
  // any nav link counts as an outside click, so navigating also closes it.
  useEffect(() => {
    if (!accountOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setAccountOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccountOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountOpen]);

  // Groups are separated by space only, so no extra translated headings.
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
        className={`fixed inset-0 z-40 bg-midnight/75 transition-opacity duration-200 lg:hidden ${
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside
        className={`
          fixed top-0 left-0 z-50 h-dvh w-64 max-w-[85vw] shrink-0 flex flex-col
          bg-surface
          transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]
          lg:h-full lg:translate-x-0 lg:static lg:z-auto
          ${isOpen ? "translate-x-0 shadow-float" : "-translate-x-full"}
        `}
      >
        {/* The drawer is full height, so the lockup would otherwise land
            under the status bar. */}
        <div
          className="flex items-center justify-between gap-2 px-5 pb-5"
          style={{ paddingTop: "calc(1.25rem + env(safe-area-inset-top))" }}
        >
          <Link href="/dashboard" className="inline-flex" aria-label="SocialAuto">
            <Wordmark markClassName="h-8 w-8" textClassName="text-[1.15rem]" />
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-hover hover:text-white lg:hidden"
            aria-label="Close menu"
          >
            <Icon name="close" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {navGroups.map((group, i) => (
            <div key={i} className={i > 0 ? "mt-6" : ""}>
              <ul className="space-y-1">
                {group.map((item) => {
                  const isActive =
                    pathname === item.href || pathname.startsWith(item.href + "/");
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        // Every section is dynamic: auto-prefetching all 11 on each page view
                        // fired ~22 RSC requests (several DB queries each) and nginx answered
                        // part of the burst with 503. Prefetch only the link the user aims at.
                        prefetch={false}
                        onMouseEnter={() => router.prefetch(item.href)}
                        onFocus={() => router.prefetch(item.href)}
                        onClick={onClose}
                        aria-current={isActive ? "page" : undefined}
                        className={`group flex items-center gap-3 rounded-full px-3.5 py-2.5 text-[15px] font-medium ${
                          isActive
                            ? "bg-violet text-white"
                            : "text-muted hover:bg-surface-hover hover:text-white"
                        }`}
                      >
                        <Icon
                          name={item.icon}
                          className={`h-[18px] w-[18px] shrink-0 ${
                            isActive ? "text-white" : "text-muted group-hover:text-white"
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

        <div ref={accountRef} className="relative p-3">
          {accountOpen && (
            <div
              id={accountMenuId}
              role="menu"
              aria-label={t.nav.account}
              className="absolute inset-x-3 bottom-[calc(100%-0.25rem)] overflow-hidden rounded-2xl bg-midnight p-1.5 shadow-float ring-1 ring-white/10"
            >
              <div className="px-3 py-2">
                <p className="truncate text-sm font-semibold text-white">{workspaceName}</p>
                {userEmail && (
                  <p className="mt-0.5 truncate text-xs text-muted">{userEmail}</p>
                )}
              </div>
              <form action={signOutAction}>
                <button
                  type="submit"
                  role="menuitem"
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium text-muted hover:bg-surface-hover hover:text-white"
                >
                  <Icon name="logout" className="h-[18px] w-[18px] shrink-0" />
                  <span>{t.nav.logout}</span>
                </button>
              </form>
            </div>
          )}
          <button
            type="button"
            onClick={() => setAccountOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            aria-controls={accountOpen ? accountMenuId : undefined}
            aria-label={t.nav.account}
            className={`flex w-full items-center gap-3 rounded-full px-2 py-2 text-left transition-colors ${
              accountOpen ? "bg-surface-hover" : "bg-midnight hover:bg-surface-hover"
            }`}
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet font-display text-sm font-semibold text-white">
              {initial}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
              {workspaceName}
            </span>
            <Icon
              name="arrowRight"
              className={`mr-1 h-4 w-4 shrink-0 text-muted transition-transform ${
                accountOpen ? "rotate-90" : "-rotate-90"
              }`}
            />
          </button>
        </div>
      </aside>
    </>
  );
}
