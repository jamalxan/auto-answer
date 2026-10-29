import ContentIntelDashboard from "@/components/developer/content-intel/content-intel-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Kontent intellekti", robots: { index: false } };

// Guarded by the dashboard layout (app session).
export default function ContentIntelPage() {
  return <ContentIntelDashboard />;
}
