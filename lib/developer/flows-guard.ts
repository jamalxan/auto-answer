import { jsonError } from "@/lib/api-auth";
import { can, isReadOnlyRole, PERMISSION_LABELS, type Permission } from "@/lib/workspace-permissions";
import { requireDeveloper, type DeveloperAuth } from "./access";

export { NOT_JSON, parseBody, readJson, respond } from "./crm-guard";

/**
 * Guards for /api/developer/flows (ETAP 6/7). On top of the developer login
 * and the app session (requireDeveloper): reads need `view_analytics` (every
 * role has it), everything that changes a flow, publishes, tests or calls the
 * AI needs `manage_campaigns` (MANAGER+) and is refused for the read-only
 * VIEWER role.
 */
export async function requireFlows(kind: "read" | "write"): Promise<DeveloperAuth> {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth;
  const permission: Permission = kind === "write" ? "manage_campaigns" : "view_analytics";
  if (kind === "write" && isReadOnlyRole(auth.ctx.role)) {
    return { ok: false, response: jsonError("Kuzatuvchi (VIEWER) rolida o'zgartirish mumkin emas", 403) };
  }
  if (!can(auth.ctx.role, permission)) {
    return { ok: false, response: jsonError(`Ruxsat yo'q: ${PERMISSION_LABELS[permission]}`, 403) };
  }
  return auth;
}
