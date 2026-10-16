import { Suspense } from "react";
import EngagementDashboard from "@/components/developer/engagement/engagement-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Engagement (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout. Suspense: the dashboard reads ?tab= / ?giveaway= / ?new=.
export default function EngagementPage() {
  return (
    <Suspense fallback={null}>
      <EngagementDashboard />
    </Suspense>
  );
}
