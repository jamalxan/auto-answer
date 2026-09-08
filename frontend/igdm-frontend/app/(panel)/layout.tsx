"use client";

import AuthGuard from "@/components/panel/AuthGuard";

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
