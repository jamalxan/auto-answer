import { Suspense } from "react";
import IntegrationsDashboard from "@/components/developer/integrations/integrations-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Integrations", robots: { index: false } };

// Guarded by the dashboard layout (app session). Suspense: the dashboard reads ?tab=.
export default function IntegrationsPage() {
  return (
    <Suspense fallback={null}>
      <IntegrationsDashboard />
    </Suspense>
  );
}
