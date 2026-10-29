import { jsonOk } from "@/lib/api-auth";
import { requireCrm } from "@/lib/developer/crm-guard";
import { listTeam } from "@/lib/crm/service";
import { PERMISSION_LABELS, PERMISSION_MATRIX, PERMISSIONS, ROLE_LABELS, canChangeRole } from "@/lib/workspace-permissions";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const members = await listTeam(auth.ctx.workspaceId);
  return jsonOk({
    members: members.map((m) => ({ ...m, canChange: m.role !== "OWNER" && canChangeRole(auth.ctx.role, m.role) })),
    permissions: PERMISSIONS,
    permissionLabels: PERMISSION_LABELS,
    roleLabels: ROLE_LABELS,
    matrix: PERMISSION_MATRIX,
  });
}
