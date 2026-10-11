import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireTriggerDev } from "@/lib/triggers/access";
import { listEvents } from "@/lib/triggers/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireTriggerDev();
  if (!auth.ok) return auth.response;

  const params = request.nextUrl.searchParams;
  const data = await listEvents(auth.ctx.workspaceId, {
    type: params.get("type"),
    status: params.get("status"),
    campaignId: params.get("campaignId"),
    accountId: params.get("accountId"),
    q: params.get("q"),
    page: Number(params.get("page") ?? 1) || 1,
    limit: Number(params.get("limit") ?? 25) || 25,
  });
  return jsonOk(data);
}
