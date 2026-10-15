import { Suspense } from "react";
import FoundationDashboard from "@/components/developer/foundation/foundation-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Foundation (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout.
export default function FoundationPage() {
  return (
    <Suspense fallback={null}>
      <FoundationDashboard />
    </Suspense>
  );
}
