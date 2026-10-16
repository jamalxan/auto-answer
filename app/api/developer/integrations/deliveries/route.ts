import { NextRequest } from "next/server";
import { requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { listDeliveries } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireIntegrations("read");
  if (!auth.ok) return auth.response;
  const params = request.nextUrl.searchParams;
  const query: Record<string, string> = {};
  for (const key of ["integrationId", "status", "type", "cursor", "limit"]) {
    const value = params.get(key);
    if (value) query[key] = value;
  }
  return respond(await listDeliveries(auth.ctx.workspaceId, query));
}
