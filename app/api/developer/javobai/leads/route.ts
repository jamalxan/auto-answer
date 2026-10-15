import { jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { listLeadsWithInsight } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  return jsonOk({ leads: await listLeadsWithInsight(auth.ctx.workspaceId) });
}
