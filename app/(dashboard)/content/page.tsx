import { Suspense } from "react";
import ContentDashboard from "@/components/content/content-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Kontent reja", robots: { index: false } };

// Guarded by the dashboard layout (app session). Suspense: the dashboard reads ?tab= / ?post= / ?new= / ?date=.
export default function ContentPage() {
  return (
    <Suspense fallback={null}>
      <ContentDashboard />
    </Suspense>
  );
}
