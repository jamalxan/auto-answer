import { Suspense } from "react";
import FlowsDashboard from "@/components/developer/flows/flows-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Flow Builder (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout. Suspense: the dashboard reads ?tab= / ?flow= / ?view=.
export default function FlowsPage() {
  return (
    <Suspense fallback={null}>
      <FlowsDashboard />
    </Suspense>
  );
}
