"use client";

/**
 * Top Bar
 *
 * Page title, mobile hamburger, and connection status. Solid midnight; the
 * sidebar's surface tone is the only separator it needs.
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
    "/content": t.nav.content,
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
  // no exact entry above; this only has to get the *section* right. Each
  // page still renders its own specific heading below this bar.
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
      className="sticky top-0 z-30 flex items-center justify-between gap-3 bg-midnight px-4 lg:px-8"
      // Installed to the home screen the app starts at the very top of the
      // display, so without this the title sits under the clock and battery.
      style={{
        height: "calc(4.25rem + env(safe-area-inset-top))",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <button
          onClick={onMenuClick}
          type="button"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-surface text-muted hover:bg-surface-hover hover:text-white lg:hidden"
          aria-label={t.nav.menu}
        >
          <Icon name="menu" className="h-[18px] w-[18px]" />
        </button>
        <h1 className="display truncate text-[1.15rem] sm:text-[1.35rem]">{title}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {instagramAccountCount > 0 ? (
          <div className="hidden min-w-0 items-center gap-2.5 rounded-full bg-surface py-1.5 pl-1.5 pr-4 sm:flex">
            <span className="relative grid h-7 w-7 place-items-center rounded-full bg-violet text-white">
              <Icon name="instagram" className="h-3.5 w-3.5" />
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-lime ring-2 ring-surface" />
            </span>
            <span className="truncate text-sm font-medium text-white">
              {instagramAccountCount > 1
                ? t.topbar.accountsCount(instagramAccountCount)
                : `@${instagramUsername}`}
            </span>
          </div>
        ) : (
          <a href="/api/instagram/connect" className="btn btn-primary !px-4 !py-2.5 !text-sm">
            <Icon name="instagram" className="h-4 w-4" />
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
