import { Suspense } from "react";
import MigrationDashboard from "@/components/developer/migration/migration-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "ManyChat Migration (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout. Suspense: the dashboard reads ?project= / ?step=.
export default function MigrationPage() {
  return (
    <Suspense fallback={null}>
      <MigrationDashboard />
    </Suspense>
  );
}
