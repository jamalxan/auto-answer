import type { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { DETAIL_NETWORKS, getNetworkDetail, type DetailNetwork } from "@/lib/analytics/network-stats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RANGES = new Set([7, 30, 90]);

type Props = { params: Promise<{ network: string }> };

/** One network in detail: per-day activity, per-post results and per-account rows. `account` narrows to one account of this workspace. */
export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const { network } = await params;
  if (!DETAIL_NETWORKS.includes(network as DetailNetwork)) return jsonError("Noma'lum tarmoq", 404);
  const days = Number(request.nextUrl.searchParams.get("days") ?? 30);
  if (!RANGES.has(days)) return jsonError("days: 7, 30 yoki 90", 400);
  const account = request.nextUrl.searchParams.get("account");
  // live=0: the database only, so the table paints at once; the client then asks again for the platform metrics.
  const live = request.nextUrl.searchParams.get("live") !== "0";
  const detail = await getNetworkDetail(auth.ctx.workspaceId, network as DetailNetwork, { days, accountId: account || null, live });
  if (!detail) return jsonError("Akkaunt topilmadi", 404);
  return jsonOk(detail);
}
