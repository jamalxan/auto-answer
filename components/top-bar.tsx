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
import Icon from "@/components/icons";

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
    "/assistant": t.assistant.nav.assistant,
    "/leads": t.assistant.nav.leads,
    "/integrations": t.assistant.nav.integrations,
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
    ["/assistant/", t.assistant.nav.assistant],
    ["/leads/", t.assistant.nav.leads],
    ["/integrations/", t.assistant.nav.integrations],
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
      className="sticky top-0 z-30 flex items-center justify-between gap-3 px-4 lg:px-8 border-b border-border bg-background/60 backdrop-blur-xl"
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
          type="button"
          className="lg:hidden grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border text-muted hover:border-border-hover hover:bg-surface-hover hover:text-foreground"
          aria-label={t.nav.menu}
        >
          <Icon name="menu" className="h-[18px] w-[18px]" />
        </button>
        <h1 className="truncate font-display text-base font-extrabold tracking-tight sm:text-lg">
          {title}
        </h1>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {instagramAccountCount > 0 ? (
          <div className="hidden min-w-0 items-center gap-2 rounded-full border border-border bg-surface/60 py-1 pl-1 pr-3 sm:flex">
            <span className="relative grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af] text-white">
              <Icon name="instagram" className="h-3.5 w-3.5" />
              <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-background" />
            </span>
            <span className="truncate text-sm font-medium text-foreground">
              {instagramAccountCount > 1
                ? t.topbar.accountsCount(instagramAccountCount)
                : `@${instagramUsername}`}
            </span>
          </div>
        ) : (
          <a
            href="/api/instagram/connect"
            className="label-mono inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-bold px-3 py-2 rounded-lg bg-accent text-background hover:bg-accent-hover"
          >
            <Icon name="instagram" className="h-3.5 w-3.5" />
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
