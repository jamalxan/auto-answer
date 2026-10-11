import { notFound } from "next/navigation";
import { Suspense } from "react";
import TriggerDashboard from "@/components/triggers/trigger-dashboard";
import { isTriggerDevSession } from "@/lib/triggers/access";

export const dynamic = "force-dynamic";

export const metadata = { title: "Instagram Triggers (dev)", robots: { index: false } };

// Dev-only: everyone outside TRIGGER_ENGINE_DEV_EMAILS gets a 404.
export default async function TriggerEnginePage() {
  if (!(await isTriggerDevSession())) notFound();
  return (
    <Suspense fallback={null}>
      <TriggerDashboard />
    </Suspense>
  );
}
