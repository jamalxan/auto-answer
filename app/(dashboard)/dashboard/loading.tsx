import { DashboardSkeleton } from "@/components/dashboard-view";

/** Shown at once on navigation while the server renders the dashboard. */
export default function DashboardLoading() {
  return <DashboardSkeleton />;
}
