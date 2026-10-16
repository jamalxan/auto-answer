import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireIntegrations } from "@/lib/developer/integrations-guard";
import { listEvents } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

/** Event catalogue (with a sample payload each) and the most recent events of the workspace. */
export async function GET(request: NextRequest) {
  const auth = await requireIntegrations("read");
  if (!auth.ok) return auth.response;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 30);
  return jsonOk(await listEvents(auth.ctx.workspaceId, Number.isFinite(limit) ? limit : 30));
}
