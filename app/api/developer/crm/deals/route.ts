import { NextRequest } from "next/server";
import { requireCrm, respond } from "@/lib/developer/crm-guard";
import { listDeals } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

/** Kanban board: ?pipelineId= (default pipeline when omitted). */
export async function GET(request: NextRequest) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  return respond(await listDeals(auth.ctx.workspaceId, request.nextUrl.searchParams.get("pipelineId")));
}
