import { Suspense } from "react";
import ChannelsDashboard from "@/components/developer/channels/channels-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Facebook · Threads · YouTube (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout. useSearchParams needs a Suspense boundary.
export default function ChannelsPage() {
  return (
    <Suspense>
      <ChannelsDashboard />
    </Suspense>
  );
}
