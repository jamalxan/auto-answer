"use client";

/**
 * Top Bar
 *
 * Page title, mobile hamburger, and connection status.
 */

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/components/language-provider";
import LanguageSwitcher from "@/components/language-switcher";

interface TopBarProps {
  onMenuClick: () => void;
  instagramUsername: string | null;
  instagramAccountCount: number;
}

export default function TopBar({
  onMenuClick,
  instagramUsername,
  instagramAccountCount,
}: TopBarProps) {
  const pathname = usePathname();
  const { t } = useLanguage();

  const exactTitles: Record<string, string> = {
    "/dashboard": t.nav.dashboard,
    "/overview": t.nav.overview,
    "/inbox": t.nav.inbox,
    "/campaigns": t.nav.campaigns,
    "/campaigns/new": t.nav.newCampaign,
    "/campaigns/import": t.campaignImport.title,
    "/automations": t.nav.campaigns,
    "/automations/new": t.nav.newCampaign,
    "/logs": t.nav.dmLogs,
    "/settings": t.nav.settings,
    "/diagnostics": t.nav.diagnostics,
  };
  // Dynamic/nested routes (/campaigns/<id>, /campaigns/<id>/edit, ...) have
  // no exact entry above, so without this the header fell back straight to
  // "Dashboard" — a campaign's own edit screen, inbox thread, etc. all read
  // "Dashboard" in the header no matter what the sidebar had selected. Each
  // page still renders its own specific heading below this bar; this only
  // has to get the *section* right.
  const sectionFallbacks: Array<[string, string]> = [
    ["/campaigns/", t.nav.campaigns],
    ["/automations/", t.nav.campaigns],
    ["/inbox/", t.nav.inbox],
    ["/logs/", t.nav.dmLogs],
    ["/settings/", t.nav.settings],
    ["/diagnostics/", t.nav.diagnostics],
    ["/overview/", t.nav.overview],
  ];
  const title =
    exactTitles[pathname] ??
    sectionFallbacks.find(([prefix]) => pathname.startsWith(prefix))?.[1] ??
    t.nav.dashboard;

  // These pages are all "use client" and fetch their own data, so none of
  // them can export the usual `metadata.title` — this is the only place
  // that knows the current section, so it also owns the browser tab title.
  useEffect(() => {
    document.title = `${title} - SocialAuto`;
  }, [title]);

  return (
    <header
      className="sticky top-0 z-30 flex items-center justify-between gap-3 px-4 lg:px-8 border-b-2 border-border bg-background"
      // Installed to the home screen the app starts at the very top of the
      // display, so without this the title sits under the clock and battery.
      // The inset is 0 in a browser tab and on desktop.
      style={{
        height: "calc(4rem + env(safe-area-inset-top))",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <button
          onClick={onMenuClick}
          className="lg:hidden shrink-0 px-2.5 py-1.5 rounded border border-border text-sm text-muted hover:text-foreground"
          aria-label="Toggle sidebar"
        >
          {t.nav.menu}
        </button>
        <h1 className="truncate font-display text-base font-extrabold sm:text-lg">
          {title}
        </h1>
      </div>

      <div className="flex shrink-0 items-center gap-3 sm:gap-4">
        {instagramAccountCount > 0 ? (
          <p className="hidden truncate text-sm text-muted sm:block">
            {instagramAccountCount > 1
              ? t.topbar.accountsCount(instagramAccountCount)
              : `@${instagramUsername}`}
          </p>
        ) : (
          <a
            href="/api/instagram/connect"
            className="label-mono whitespace-nowrap text-xs font-bold px-3 py-1.5 rounded bg-accent text-background hover:bg-accent-hover"
          >
            {/* Full label needs more room than a 360px header has to spare. */}
            <span className="sm:hidden">{t.topbar.connect}</span>
            <span className="hidden sm:inline">{t.topbar.connectInstagram}</span>
          </a>
        )}
        <LanguageSwitcher />
      </div>
    </header>
  );
}
