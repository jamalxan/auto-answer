import { jsonError } from "@/lib/api-auth";
import { can, isReadOnlyRole, PERMISSION_LABELS, type Permission } from "@/lib/workspace-permissions";
import { requireWorkspace, type WorkspaceAuth } from "@/lib/channels/guard";

/**
 * Guards for /api/analytics (ETAP 10). On top of the developer login
 * and the app session (requireWorkspace): reads need `view_analytics` (every
 * role has it); recompute and backfill cost database time, so they need
 * `manage_campaigns` (MANAGER+) and refuse the read-only VIEWER role.
 */
export async function requireAnalytics(options: { manage?: boolean } = {}): Promise<WorkspaceAuth> {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth;
  const permission: Permission = options.manage ? "manage_campaigns" : "view_analytics";
  if (options.manage && isReadOnlyRole(auth.ctx.role)) {
    return { ok: false, response: jsonError("Kuzatuvchi (VIEWER) rolida o'zgartirish mumkin emas", 403) };
  }
  if (!can(auth.ctx.role, permission)) {
    return { ok: false, response: jsonError(`Ruxsat yo'q: ${PERMISSION_LABELS[permission]}`, 403) };
  }
  return auth;
}
