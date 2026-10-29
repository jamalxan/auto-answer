import { jsonOk } from "@/lib/api-auth";
import { requireCrm } from "@/lib/developer/crm-guard";
import { ensureWorkspaceDefaults, getOverview } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireCrm("view_analytics");
  if (!auth.ok) return auth.response;
  await ensureWorkspaceDefaults(auth.ctx.workspaceId);
  return jsonOk(await getOverview(auth.ctx.workspaceId));
}
