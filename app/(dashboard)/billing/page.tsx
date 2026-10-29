import BillingDashboard from "@/components/developer/billing/billing-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tariflar", robots: { index: false } };

// Guarded by the dashboard layout (app session).
export default function BillingPage() {
  return <BillingDashboard />;
}
