import { Suspense } from "react";
import JavobAiDashboard from "@/components/developer/javobai/javobai-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "JavobAI (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout. Suspense: the dashboard reads ?tab= / ?account=.
export default function JavobAiPage() {
  return (
    <Suspense fallback={null}>
      <JavobAiDashboard />
    </Suspense>
  );
}
