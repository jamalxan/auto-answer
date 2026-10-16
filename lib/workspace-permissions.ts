/**
 * Workspace permission matrix (TZ 53, ETAP 5.3).
 *
 * Roles: OWNER / ADMIN / MANAGER / OPERATOR / VIEWER. `MEMBER` is the legacy
 * alias of OPERATOR until the enum migration adds the new values, so this
 * module takes the role as a plain string (Prisma's WorkspaceRole does not
 * include MANAGER / OPERATOR / VIEWER yet) and treats anything unknown as
 * VIEWER — the least a stranger can do is read.
 *
 * lib/workspace-access.ts (canManageWorkspace, canManageBilling) stays the
 * gate for "is a manager at all"; this matrix is the finer-grained check for
 * the CRM screens and APIs. Pure.
 */

export type Permission =
  | "manage_instagram"
  | "manage_campaigns"
  | "view_contacts"
  | "assign_leads"
  | "manage_billing"
  | "manage_ai"
  | "export_data"
  | "view_analytics";

export const PERMISSIONS: Permission[] = [
  "manage_instagram",
  "manage_campaigns",
  "view_contacts",
  "assign_leads",
  "manage_billing",
  "manage_ai",
  "export_data",
  "view_analytics",
];

export type PermissionRole = "OWNER" | "ADMIN" | "MANAGER" | "OPERATOR" | "VIEWER";

export const PERMISSION_ROLES: PermissionRole[] = ["OWNER", "ADMIN", "MANAGER", "OPERATOR", "VIEWER"];

export const ROLE_LABELS: Record<PermissionRole, string> = {
  OWNER: "Egasi",
  ADMIN: "Administrator",
  MANAGER: "Menejer",
  OPERATOR: "Operator",
  VIEWER: "Kuzatuvchi",
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  manage_instagram: "Instagram akkauntlarini boshqarish",
  manage_campaigns: "Kampaniyalarni boshqarish",
  view_contacts: "Kontaktlarni ko'rish",
  assign_leads: "Leadlarni biriktirish",
  manage_billing: "To'lov va tarifni boshqarish",
  manage_ai: "JavobAI sozlamalari",
  export_data: "Ma'lumotlarni eksport qilish",
  view_analytics: "Analitikani ko'rish",
};

/**
 * Who may do what. OWNER everything; ADMIN everything but billing; MANAGER
 * runs campaigns, AI, leads and exports but does not touch Instagram
 * connections; OPERATOR works contacts (and takes / releases leads for
 * themselves via "assign_leads" — reassigning someone else's lead is a
 * MANAGER action, enforced by the DB layer); VIEWER only reads.
 */
export const PERMISSION_MATRIX: Record<PermissionRole, Record<Permission, boolean>> = {
  OWNER: {
    manage_instagram: true,
    manage_campaigns: true,
    view_contacts: true,
    assign_leads: true,
    manage_billing: true,
    manage_ai: true,
    export_data: true,
    view_analytics: true,
  },
  ADMIN: {
    manage_instagram: true,
    manage_campaigns: true,
    view_contacts: true,
    assign_leads: true,
    manage_billing: false,
    manage_ai: true,
    export_data: true,
    view_analytics: true,
  },
  MANAGER: {
    manage_instagram: false,
    manage_campaigns: true,
    view_contacts: true,
    assign_leads: true,
    manage_billing: false,
    manage_ai: true,
    export_data: true,
    view_analytics: true,
  },
  OPERATOR: {
    manage_instagram: false,
    manage_campaigns: false,
    view_contacts: true,
    assign_leads: true,
    manage_billing: false,
    manage_ai: false,
    export_data: false,
    view_analytics: true,
  },
  VIEWER: {
    manage_instagram: false,
    manage_campaigns: false,
    view_contacts: true,
    assign_leads: false,
    manage_billing: false,
    manage_ai: false,
    export_data: false,
    view_analytics: true,
  },
};

/** Maps any role string (incl. legacy MEMBER and unknown values) onto the matrix. */
export function normalizeRole(role: string | null | undefined): PermissionRole {
  const upper = (role ?? "").toUpperCase();
  if (upper === "MEMBER") return "OPERATOR";
  return PERMISSION_ROLES.includes(upper as PermissionRole) ? (upper as PermissionRole) : "VIEWER";
}

export function can(role: string | null | undefined, permission: Permission): boolean {
  return PERMISSION_MATRIX[normalizeRole(role)][permission] === true;
}

/** Every permission the role has, in matrix order (for the Team tab). */
export function permissionsOf(role: string | null | undefined): Permission[] {
  const row = PERMISSION_MATRIX[normalizeRole(role)];
  return PERMISSIONS.filter((permission) => row[permission]);
}

/** VIEWER (and unknown roles) may not write anything: 403 on every mutation. */
export function isReadOnlyRole(role: string | null | undefined): boolean {
  return normalizeRole(role) === "VIEWER";
}

/** Who may change another member's role: OWNER everyone, ADMIN everyone below ADMIN. */
export function canChangeRole(actorRole: string | null | undefined, targetRole: string | null | undefined): boolean {
  const actor = normalizeRole(actorRole);
  const target = normalizeRole(targetRole);
  if (actor === "OWNER") return true;
  if (actor === "ADMIN") return target !== "OWNER" && target !== "ADMIN";
  return false;
}

/**
 * The production leads CSV (/api/leads/export.csv). Before ETAP 5 every
 * workspace member could export, so the legacy MEMBER role keeps that right
 * (no regression for existing teams); the new roles follow the TZ 53 matrix:
 * OWNER / ADMIN / MANAGER yes, OPERATOR / VIEWER no.
 */
export function canExportLeads(role: string | null | undefined): boolean {
  if ((role ?? "").toUpperCase() === "MEMBER") return true;
  return can(role, "export_data");
}
