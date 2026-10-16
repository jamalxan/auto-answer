import type { WorkspaceRole } from "@/app/generated/prisma/client";

/**
 * Role ordering, free of any auth/session import so the Telegram bot and the
 * workers can use it without pulling next-auth into their bundle.
 * lib/workspace-access.ts re-exports these for the app routes.
 *
 * ETAP 5 (TZ 53): VIEWER < OPERATOR = MEMBER (legacy name) < MANAGER < ADMIN
 * < OWNER. Only ADMIN and OWNER manage the workspace; the finer permission
 * matrix lives in lib/workspace-permissions.ts.
 */
const ROLE_ORDER: Record<WorkspaceRole, number> = {
  VIEWER: 1,
  OPERATOR: 2,
  MEMBER: 2,
  MANAGER: 3,
  ADMIN: 4,
  OWNER: 5,
};

export function hasWorkspaceRole(role: WorkspaceRole, minimumRole: WorkspaceRole) {
  return ROLE_ORDER[role] >= ROLE_ORDER[minimumRole];
}

export function canManageWorkspace(role: WorkspaceRole) {
  return hasWorkspaceRole(role, "ADMIN");
}

export function canManageBilling(role: WorkspaceRole) {
  return role === "OWNER";
}
