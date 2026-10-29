import { Suspense } from "react";
import AnalyticsDashboard from "@/components/developer/analytics/analytics-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Analitika", robots: { index: false } };

// Guarded by the dashboard layout (app session). Suspense: the dashboard reads ?tab= and the range from the URL.
export default function AnalyticsPage() {
  return (
    <Suspense fallback={null}>
      <AnalyticsDashboard />
    </Suspense>
  );
}
