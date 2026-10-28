import { Suspense } from "react";
import TriggerDashboard from "@/components/triggers/trigger-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Instagram Triggers", robots: { index: false } };

// Guarded by the dashboard layout (app session).
export default function TriggerEnginePage() {
  return (
    <Suspense fallback={null}>
      <TriggerDashboard />
    </Suspense>
  );
}
