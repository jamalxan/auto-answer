"use client";

import Link from "next/link";
import { useState } from "react";
import Sidebar from "@/components/sidebar";
import TopBar from "@/components/top-bar";

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
    <div className="flex h-dvh overflow-hidden bg-background">
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
              <div className="mb-5 rounded border-2 border-red-500/40 bg-red-500/10 p-4">
                <p className="text-sm font-bold text-red-500">{suspendedBanner.title}</p>
                <p className="mt-1 text-sm text-red-500/90">{suspendedBanner.body}</p>
              </div>
            )}
            {tokenBanner && (
              <div className="mb-5 rounded border-2 border-red-500/40 bg-red-500/10 p-4">
                <p className="text-sm font-bold text-red-500">{tokenBanner.title}</p>
                <p className="mt-1 text-sm text-red-500/90">{tokenBanner.body}</p>
                <Link
                  href="/settings"
                  className="mt-2 inline-block text-sm font-semibold text-red-500 underline"
                >
                  {tokenBanner.cta}
                </Link>
              </div>
            )}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
