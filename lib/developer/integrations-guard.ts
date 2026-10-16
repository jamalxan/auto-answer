import { jsonError } from "@/lib/api-auth";
import { can, isReadOnlyRole, PERMISSION_LABELS, type Permission } from "@/lib/workspace-permissions";
import { requireDeveloper, type DeveloperAuth } from "./access";

export { NOT_JSON, parseBody, readJson, respond } from "./crm-guard";

/**
 * Guards for /api/developer/integrations (ETAP 8). On top of the developer
 * login and the app session every handler names what it needs:
 *
 *   read      `view_analytics` (every role incl. VIEWER): connectors, events, delivery list
 *   payload   `manage_campaigns`: the frozen payload and response of one delivery
 *             (it holds full phone numbers — owner decision — so VIEWER / OPERATOR do not see it)
 *   write     `manage_campaigns` and not VIEWER: create / edit / test / redeliver / rotate
 */
export type IntegrationsAccess = "read" | "payload" | "write";

const PERMISSION_OF: Record<IntegrationsAccess, Permission> = {
  read: "view_analytics",
  payload: "manage_campaigns",
  write: "manage_campaigns",
};

export async function requireIntegrations(access: IntegrationsAccess): Promise<DeveloperAuth> {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth;
  if (access === "write" && isReadOnlyRole(auth.ctx.role)) {
    return { ok: false, response: jsonError("Kuzatuvchi (VIEWER) rolida o'zgartirish mumkin emas", 403) };
  }
  const permission = PERMISSION_OF[access];
  if (!can(auth.ctx.role, permission)) {
    return { ok: false, response: jsonError(`Ruxsat yo'q: ${PERMISSION_LABELS[permission]}`, 403) };
  }
  return auth;
}
