import BillingDashboard from "@/components/developer/billing/billing-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tariflar (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout.
export default function BillingPage() {
  return <BillingDashboard />;
}
