import { jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { listLeadsWithInsight } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  return jsonOk({ leads: await listLeadsWithInsight(auth.ctx.workspaceId) });
}
