"use client";

import Link from "next/link";
import { useState } from "react";
import Sidebar from "@/components/sidebar";
import TopBar from "@/components/top-bar";
import Icon from "@/components/icons";

function AlertBanner({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex gap-3 rounded-2xl bg-error/12 p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-error/20 text-error">
        <Icon name="alert" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-white">{title}</p>
        <p className="mt-0.5 text-sm text-cloud/85">{body}</p>
        {children}
      </div>
    </div>
  );
}

function TelegramBanner({ title, body, cta }: { title: string; body: string; cta: string }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  // Non-blocking: amber, dismissible for this visit, never replaces the page.
  return (
    <div className="mb-6 flex gap-3 rounded-2xl bg-warning/12 p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warning/20 text-warning">
        <Icon name="alert" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-white">{title}</p>
        <p className="mt-0.5 text-sm text-cloud/85">{body}</p>
        <Link
          href="/integrations"
          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-warning/20 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-warning/30"
        >
          {cta}
          <Icon name="arrowRight" className="h-3.5 w-3.5" />
        </Link>
      </div>
      <button
        type="button"
        onClick={() => setHidden(true)}
        aria-label="×"
        className="h-9 w-9 shrink-0 rounded-full text-cloud/70 hover:bg-warning/20 hover:text-white"
      >
        ×
      </button>
    </div>
  );
}

interface DashboardShellProps {
  children: React.ReactNode;
  workspaceName: string;
  instagramUsername: string | null;
  instagramAccountCount: number;
  isAdmin?: boolean;
  suspendedBanner?: { title: string; body: string } | null;
  tokenBanner?: { title: string; body: string; cta: string } | null;
  /** B-27: Telegram not connected, so no warning reaches anyone. */
  telegramBanner?: { title: string; body: string; cta: string } | null;
}

export default function DashboardShell({
  children,
  workspaceName,
  instagramUsername,
  instagramAccountCount,
  isAdmin = false,
  suspendedBanner = null,
  tokenBanner = null,
  telegramBanner = null,
}: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    // h-dvh, not h-screen: on mobile browsers the URL bar eats into 100vh, which
    // would push the composer and pagination controls below the fold.
    <div className="flex h-dvh overflow-hidden bg-midnight">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        workspaceName={workspaceName}
        isAdmin={isAdmin}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar
          onMenuClick={() => setSidebarOpen(true)}
          instagramUsername={instagramUsername}
          instagramAccountCount={instagramAccountCount}
        />

        {/* overflow-x-hidden: enabling vertical scrolling makes the browser
            allow horizontal scrolling too, which lets a wide child drag the
            whole page sideways on a phone. */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-7xl px-4 py-5 sm:py-6 lg:px-8">
            {suspendedBanner && (
              <AlertBanner title={suspendedBanner.title} body={suspendedBanner.body} />
            )}
            {tokenBanner && (
              <AlertBanner title={tokenBanner.title} body={tokenBanner.body}>
                <Link
                  href="/settings"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-error/20 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-error/30"
                >
                  {tokenBanner.cta}
                  <Icon name="arrowRight" className="h-3.5 w-3.5" />
                </Link>
              </AlertBanner>
            )}
            {telegramBanner && <TelegramBanner {...telegramBanner} />}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
