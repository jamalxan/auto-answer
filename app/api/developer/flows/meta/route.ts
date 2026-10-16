import { jsonOk } from "@/lib/api-auth";
import { requireFlows, respond } from "@/lib/developer/flows-guard";
import { meta, run } from "@/lib/flows/service";
import { can, isReadOnlyRole, normalizeRole } from "@/lib/workspace-permissions";

export const dynamic = "force-dynamic";

/** Everything the editor needs in one call, plus what the caller may do. */
export async function GET() {
  const auth = await requireFlows("read");
  if (!auth.ok) return auth.response;
  const result = await run(() => meta(auth.ctx.workspaceId));
  if (!result.ok) return respond(result);
  return jsonOk({
    ...result.data,
    me: {
      userId: auth.ctx.userId,
      role: normalizeRole(auth.ctx.role),
      canWrite: !isReadOnlyRole(auth.ctx.role) && can(auth.ctx.role, "manage_campaigns"),
    },
  });
}
