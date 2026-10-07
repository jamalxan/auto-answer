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
    <div className="mb-6 flex gap-3 rounded-xl border border-red-500/30 bg-red-500/[0.08] p-4">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-red-500/15 text-red-400">
        <Icon name="alert" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-red-300">{title}</p>
        <p className="mt-0.5 text-sm text-red-200/80">{body}</p>
        {children}
      </div>
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
}

export default function DashboardShell({
  children,
  workspaceName,
  instagramUsername,
  instagramAccountCount,
  isAdmin = false,
  suspendedBanner = null,
  tokenBanner = null,
}: DashboardShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    // h-dvh, not h-screen: on mobile browsers the URL bar eats into 100vh, which
    // would push the composer and pagination controls below the fold.
    // No bg here: the body's background glows show through.
    <div className="flex h-dvh overflow-hidden">
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
          <div className="px-4 lg:px-8 py-5 sm:py-6 max-w-7xl mx-auto">
            {suspendedBanner && (
              <AlertBanner title={suspendedBanner.title} body={suspendedBanner.body} />
            )}
            {tokenBanner && (
              <AlertBanner title={tokenBanner.title} body={tokenBanner.body}>
                <Link
                  href="/settings"
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-1.5 text-sm font-semibold text-red-300 hover:bg-red-500/25"
                >
                  {tokenBanner.cta}
                  <Icon name="arrowRight" className="h-3.5 w-3.5" />
                </Link>
              </AlertBanner>
            )}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
