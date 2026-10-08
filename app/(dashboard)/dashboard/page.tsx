import { redirect } from "next/navigation";
import DashboardView, { type DashboardStats } from "@/components/dashboard-view";
import { getCurrentUserId, getCurrentWorkspaceId } from "@/lib/auth";
import { getDashboardStats, getLeadCards } from "@/lib/dashboard/stats";
import { getServerLocale } from "@/lib/i18n/get-locale";

/**
 * Dashboard home. The numbers are rendered on the server: the page arrives
 * with its data instead of loading empty and fetching it in two more round
 * trips (each one costs ~0.4s between Uzbekistan and the server).
 */
export default async function DashboardPage() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) redirect("/login");

  const [stats, cards] = await Promise.all([
    getDashboardStats({
      workspaceId,
      userId: await getCurrentUserId(),
      locale: await getServerLocale(),
      selectedAccountId: null,
    }),
    getLeadCards(workspaceId),
  ]);

  // Plain JSON, the same shape the API returns to the account switcher.
  const initialStats = JSON.parse(JSON.stringify(stats)) as DashboardStats;
  return <DashboardView initialStats={initialStats} initialCards={cards} />;
}
