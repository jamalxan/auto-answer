import { Suspense } from "react";
import OverviewDashboard from "@/components/overview/overview-dashboard";

// Guarded by the dashboard layout (app session). Suspense: the dashboard reads ?n= / ?days= / ?account=.
export default function OverviewPage() {
  return (
    <Suspense fallback={null}>
      <OverviewDashboard />
    </Suspense>
  );
}
