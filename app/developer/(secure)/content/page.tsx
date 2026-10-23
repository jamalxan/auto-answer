import { Suspense } from "react";
import ContentDashboard from "@/components/developer/content/content-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Content Scheduler (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout. Suspense: the dashboard reads ?tab= / ?post= / ?new= / ?date=.
export default function ContentPage() {
  return (
    <Suspense fallback={null}>
      <ContentDashboard />
    </Suspense>
  );
}
