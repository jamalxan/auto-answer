/**
 * ETAP 13 — who may do what with scheduled content (spec FR-A1), and whether
 * an Instagram connection carries the publish scope at all.
 *
 * Built on the TZ 53 roles (lib/workspace-permissions): VIEWER looks,
 * OPERATOR (and the legacy MEMBER) drafts and sends to review, MANAGER /
 * ADMIN / OWNER schedule, publish and approve. Pure.
 */

import { normalizeRole, type PermissionRole } from "@/lib/workspace-permissions";

export const PUBLISH_SCOPE = "instagram_business_content_publish";

export function canPublishFromScopes(scopes: readonly string[]): boolean {
  return scopes.some((scope) => scope.trim().toLowerCase() === PUBLISH_SCOPE);
}

export type ContentPermission = "content.view" | "content.create" | "content.schedule" | "content.approve";

const MATRIX: Record<PermissionRole, Record<ContentPermission, boolean>> = {
  OWNER: { "content.view": true, "content.create": true, "content.schedule": true, "content.approve": true },
  ADMIN: { "content.view": true, "content.create": true, "content.schedule": true, "content.approve": true },
  MANAGER: { "content.view": true, "content.create": true, "content.schedule": true, "content.approve": true },
  OPERATOR: { "content.view": true, "content.create": true, "content.schedule": false, "content.approve": false },
  VIEWER: { "content.view": true, "content.create": false, "content.schedule": false, "content.approve": false },
};

export const CONTENT_PERMISSION_LABELS: Record<ContentPermission, string> = {
  "content.view": "Kontentni ko'rish",
  "content.create": "Post yaratish",
  "content.schedule": "Postni rejalashtirish va chiqarish",
  "content.approve": "Postni tasdiqlash",
};

export function canContent(role: string | null | undefined, permission: ContentPermission): boolean {
  return MATRIX[normalizeRole(role)][permission] === true;
}
