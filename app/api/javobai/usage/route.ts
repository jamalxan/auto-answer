import { jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { getUsage } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

/** This month's LlmUsage grouped by kind (javobai_* vs production) and the budget. */
export async function GET() {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  return jsonOk(await getUsage(auth.ctx.workspaceId));
}
