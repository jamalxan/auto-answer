import type { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { getNetworkStats } from "@/lib/analytics/network-stats";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RANGES = new Set([7, 30, 90]);

/** Statistics of every connected network (Instagram, Facebook, Threads, YouTube, Telegram) for the last 7 / 30 / 90 days. */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const days = Number(request.nextUrl.searchParams.get("days") ?? 30);
  if (!RANGES.has(days)) return jsonError("days: 7, 30 yoki 90", 400);
  return jsonOk(await getNetworkStats(auth.ctx.workspaceId, { days }));
}
