import { Suspense } from "react";
import AdsDashboard from "@/components/developer/ads/ads-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Reklama (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout. useSearchParams needs a Suspense boundary.
export default function AdsPage() {
  return (
    <Suspense>
      <AdsDashboard />
    </Suspense>
  );
}
