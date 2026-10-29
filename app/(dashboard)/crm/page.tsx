import { Suspense } from "react";
import CrmDashboard from "@/components/developer/crm/crm-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "CRM", robots: { index: false } };

// Guarded by the dashboard layout (app session). Suspense: the dashboard reads ?tab= / ?contact= / ?broadcast=.
export default function CrmPage() {
  return (
    <Suspense fallback={null}>
      <CrmDashboard />
    </Suspense>
  );
}
