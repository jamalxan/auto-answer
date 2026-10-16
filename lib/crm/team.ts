/**
 * ETAP 5.3 — the Team tab (TZ 53): members with their role, permissions,
 * active assignments and Telegram link, plus the role change guarded by
 * lib/workspace-permissions `canChangeRole`.
 *
 * Rules: the OWNER's role never changes; only OWNER / ADMIN change roles;
 * nobody is promoted to OWNER here (ownership transfer is not a CRM action);
 * an ADMIN neither touches another ADMIN nor creates one.
 */

import { z } from "zod";
import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  canChangeRole,
  normalizeRole,
  permissionsOf as permissionsOfRole,
  ROLE_LABELS,
  type Permission,
  type PermissionRole,
} from "@/lib/workspace-permissions";
import { forbidden, notFound, unprocessable } from "./errors";

export const ASSIGNABLE_ROLES = ["ADMIN", "MANAGER", "OPERATOR", "VIEWER"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const roleInputSchema = z.enum(ASSIGNABLE_ROLES, { message: "Rol noto'g'ri: ADMIN, MANAGER, OPERATOR yoki VIEWER" });

export const MEMBER_NOT_FOUND = "A'zo topilmadi";
export const OWNER_IMMUTABLE = "Egasining rolini o'zgartirib bo'lmaydi";
export const ROLE_CHANGE_FORBIDDEN = "Faqat egasi yoki administrator rollarni o'zgartira oladi";
export const ROLE_TARGET_FORBIDDEN = "Bu a'zoning rolini o'zgartirishga ruxsatingiz yo'q";
export const ADMIN_BY_OWNER_ONLY = "Administrator rolini faqat egasi bera oladi";

export interface TeamMember {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  /** Stored value (may be the legacy MEMBER). */
  role: WorkspaceRole;
  /** Matrix role (MEMBER → OPERATOR). */
  normalizedRole: PermissionRole;
  roleLabel: string;
  permissions: Permission[];
  activeAssignments: number;
  telegramLinked: boolean;
  createdAt: Date;
}

export async function listTeam(workspaceId: string): Promise<TeamMember[]> {
  const [members, assignments, telegram] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: { id: true, userId: true, role: true, createdAt: true, user: { select: { name: true, email: true } } },
    }),
    prisma.crmAssignment.findMany({ where: { workspaceId, active: true }, select: { memberId: true } }),
    prisma.telegramUser.findMany({ where: { workspaceId }, select: { userId: true } }),
  ]);
  const activeByMember = new Map<string, number>();
  for (const row of assignments) activeByMember.set(row.memberId, (activeByMember.get(row.memberId) ?? 0) + 1);
  const linked = new Set(telegram.map((row) => row.userId));

  const order: Record<PermissionRole, number> = { OWNER: 0, ADMIN: 1, MANAGER: 2, OPERATOR: 3, VIEWER: 4 };
  return members
    .map((member) => {
      const normalizedRole = normalizeRole(member.role);
      return {
        id: member.id,
        userId: member.userId,
        name: member.user?.name ?? null,
        email: member.user?.email ?? null,
        role: member.role,
        normalizedRole,
        roleLabel: ROLE_LABELS[normalizedRole],
        permissions: permissionsOfRole(normalizedRole),
        activeAssignments: activeByMember.get(member.id) ?? 0,
        telegramLinked: linked.has(member.userId),
        createdAt: member.createdAt,
      };
    })
    .sort((a, b) => order[a.normalizedRole] - order[b.normalizedRole] || a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Changes a member's role. `actorRole` is the caller's role in the same
 * workspace. 403 when the caller may not, 422 when the target or the new
 * role is not allowed, 404 when the member is of another workspace.
 */
export async function setMemberRole(workspaceId: string, actorRole: string, memberId: string, role: unknown) {
  const parsed = roleInputSchema.safeParse(typeof role === "string" ? role.toUpperCase() : role);
  if (!parsed.success) throw unprocessable(parsed.error.issues[0]?.message ?? "Rol noto'g'ri");
  const actor = normalizeRole(actorRole);
  if (actor !== "OWNER" && actor !== "ADMIN") throw forbidden(ROLE_CHANGE_FORBIDDEN);

  const member = await prisma.workspaceMember.findFirst({ where: { id: memberId, workspaceId } });
  if (!member) throw notFound(MEMBER_NOT_FOUND);
  if (member.role === "OWNER") throw unprocessable(OWNER_IMMUTABLE);
  if (!canChangeRole(actorRole, member.role)) throw forbidden(ROLE_TARGET_FORBIDDEN);
  if (parsed.data === "ADMIN" && actor !== "OWNER") throw forbidden(ADMIN_BY_OWNER_ONLY);

  if (member.role === parsed.data) return member;
  return prisma.workspaceMember.update({ where: { id: member.id }, data: { role: parsed.data } });
}

/** The matrix row for a role (MEMBER = OPERATOR, unknown = VIEWER). */
export function permissionsOf(role: string | null | undefined): Permission[] {
  return permissionsOfRole(role);
}
