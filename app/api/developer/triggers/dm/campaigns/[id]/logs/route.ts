import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { NOT_FOUND } from "@/lib/triggers/campaign-editing";
import { listDmCampaignLogs } from "@/lib/triggers/dm-trigger-service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const search = request.nextUrl.searchParams;
  const logs = await listDmCampaignLogs(auth.ctx.workspaceId, id, {
    page: Number(search.get("page") ?? 1),
    limit: Number(search.get("limit") ?? 20),
    status: search.get("status"),
  });
  if (!logs) return jsonError(NOT_FOUND, 404);
  return jsonOk(logs);
}
