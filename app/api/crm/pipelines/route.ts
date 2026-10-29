import { jsonOk } from "@/lib/api-auth";
import { requireCrm } from "@/lib/developer/crm-guard";
import { ensureDefaultPipeline, listPipelines } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  await ensureDefaultPipeline(auth.ctx.workspaceId);
  return jsonOk({ pipelines: await listPipelines(auth.ctx.workspaceId) });
}
