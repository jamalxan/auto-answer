import ChannelsDashboard from "@/components/channels/channels-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Kanallar", robots: { index: false } };

// Guarded by the dashboard layout (app session); the API checks the role per action.
export default function ChannelsPage() {
  return <ChannelsDashboard />;
}
