import AdsDashboard from "@/components/ads/ads-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Reklama", robots: { index: false } };

// Guarded by the dashboard layout (app session); only the workspace owner approves spend.
export default function AdsPage() {
  return <AdsDashboard />;
}
