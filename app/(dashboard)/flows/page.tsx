import { Suspense } from "react";
import FlowsDashboard from "@/components/developer/flows/flows-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Flow Builder", robots: { index: false } };

// Guarded by the dashboard layout (app session). Suspense: the dashboard reads ?tab= / ?flow= / ?view=.
export default function FlowsPage() {
  return (
    <Suspense fallback={null}>
      <FlowsDashboard />
    </Suspense>
  );
}
