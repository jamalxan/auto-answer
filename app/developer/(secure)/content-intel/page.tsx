import ContentIntelDashboard from "@/components/developer/content-intel/content-intel-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Kontent intellekti (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout.
export default function ContentIntelPage() {
  return <ContentIntelDashboard />;
}
