import { jsonOk } from "@/lib/api-auth";
import { requireCrm } from "@/lib/developer/crm-guard";
import { prisma } from "@/lib/db/client";
import { FIELD_SPECS, CUSTOM_FIELD_SPEC, ensureWorkspaceDefaults, listPipelines, listSegments, listTags, listTeam, isCrmEnabled } from "@/lib/crm/service";
import {
  ASSIGNMENT_STRATEGY_LABELS,
  ASSIGNMENT_TRIGGER_LABELS,
  CONTACT_SOURCE_LABELS,
  CONTACT_STATUS_LABELS,
  INELIGIBILITY_LABELS,
  STAGE_KIND_LABELS,
  TEMPERATURE_LABELS,
} from "@/lib/crm/types";
import { DEFAULT_BROADCAST } from "@/lib/crm/defaults";
import { PERMISSION_LABELS, PERMISSION_MATRIX, ROLE_LABELS, can, normalizeRole, permissionsOf } from "@/lib/workspace-permissions";

export const dynamic = "force-dynamic";

/** Everything the builders need in one call: accounts, members, pipelines, tags, segments, field specs, labels, the caller's permissions. */
export async function GET() {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const { workspaceId, role, userId } = auth.ctx;
  await ensureWorkspaceDefaults(workspaceId);
  const [accounts, members, pipelines, tags, segments] = await Promise.all([
    prisma.instagramAccount.findMany({ where: { workspaceId }, orderBy: { connectedAt: "desc" }, select: { id: true, username: true, tokenStatus: true } }),
    listTeam(workspaceId),
    listPipelines(workspaceId),
    listTags(workspaceId),
    listSegments(workspaceId),
  ]);
  const me = members.find((m) => m.userId === userId) ?? null;
  return jsonOk({
    disabled: !isCrmEnabled(),
    me: {
      userId,
      memberId: me?.id ?? null,
      role,
      normalizedRole: normalizeRole(role),
      permissions: permissionsOf(role),
      canManage: can(role, "manage_campaigns"),
    },
    accounts,
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.name,
      email: m.email,
      role: m.role,
      normalizedRole: m.normalizedRole,
      roleLabel: m.roleLabel,
      telegramLinked: m.telegramLinked,
    })),
    pipelines,
    tags,
    segments: segments.map((s) => ({ id: s.id, name: s.name, description: s.description, lastCount: s.lastCount })),
    fieldSpecs: FIELD_SPECS,
    customFieldSpec: CUSTOM_FIELD_SPEC,
    labels: {
      status: CONTACT_STATUS_LABELS,
      temperature: TEMPERATURE_LABELS,
      source: CONTACT_SOURCE_LABELS,
      stageKind: STAGE_KIND_LABELS,
      strategy: ASSIGNMENT_STRATEGY_LABELS,
      trigger: ASSIGNMENT_TRIGGER_LABELS,
      ineligibility: INELIGIBILITY_LABELS,
      role: ROLE_LABELS,
      permission: PERMISSION_LABELS,
    },
    permissionMatrix: PERMISSION_MATRIX,
    broadcastDefaults: DEFAULT_BROADCAST,
  });
}
