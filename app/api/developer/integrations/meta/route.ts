import { jsonOk } from "@/lib/api-auth";
import { requireIntegrations } from "@/lib/developer/integrations-guard";
import { getMeta } from "@/lib/integrations2/service";
import { can, isReadOnlyRole, normalizeRole } from "@/lib/workspace-permissions";

export const dynamic = "force-dynamic";

/** Catalogue, limits and the caller's own rights (the screen hides what the API would refuse). */
export async function GET() {
  const auth = await requireIntegrations("read");
  if (!auth.ok) return auth.response;
  const meta = await getMeta(auth.ctx.workspaceId);
  const manage = can(auth.ctx.role, "manage_campaigns");
  return jsonOk({
    ...meta,
    me: {
      role: normalizeRole(auth.ctx.role),
      canWrite: manage && !isReadOnlyRole(auth.ctx.role),
      canViewPayload: manage,
    },
  });
}
