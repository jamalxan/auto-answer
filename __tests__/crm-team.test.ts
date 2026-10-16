/**
 * ETAP 5.3 — Team tab: member listing with permissions / assignments /
 * Telegram link, and the role change permission matrix.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});

import { listTeam, permissionsOf, setMemberRole } from "../lib/crm/team";
import { db, resetDb } from "./helpers/db-instance";

function seed() {
  db.seed("workspace", { id: "w1", ownerId: "u_owner", name: "Mebel" });
  db.seed("workspace", { id: "w2", ownerId: "u_other", name: "Boshqa" });
  db.seed("user", { id: "u_owner", name: "Egasi", email: "owner@example.com" });
  db.seed("user", { id: "u_admin", name: "Admin", email: "admin@example.com" });
  db.seed("user", { id: "u_op", name: null, email: "op@example.com" });
  db.seed("user", { id: "u_legacy", name: "Eski", email: "legacy@example.com" });
  db.seed("user", { id: "u_other", name: "Begona", email: "other@example.com" });
  db.seed("workspaceMember", { id: "m_owner", workspaceId: "w1", userId: "u_owner", role: "OWNER" });
  db.seed("workspaceMember", { id: "m_admin", workspaceId: "w1", userId: "u_admin", role: "ADMIN" });
  db.seed("workspaceMember", { id: "m_op", workspaceId: "w1", userId: "u_op", role: "OPERATOR" });
  db.seed("workspaceMember", { id: "m_legacy", workspaceId: "w1", userId: "u_legacy", role: "MEMBER" });
  db.seed("workspaceMember", { id: "m_other", workspaceId: "w2", userId: "u_other", role: "OWNER" });
  db.seed("telegramUser", { tgUserId: "555", userId: "u_op", workspaceId: "w1" });
  db.seed("crmAssignment", { workspaceId: "w1", contactId: "c1", memberId: "m_op", reason: "manual", active: true });
  db.seed("crmAssignment", { workspaceId: "w1", contactId: "c2", memberId: "m_op", reason: "manual", active: true });
  db.seed("crmAssignment", { workspaceId: "w1", contactId: "c3", memberId: "m_op", reason: "manual", active: false });
  db.seed("crmAssignment", { workspaceId: "w1", contactId: "c4", memberId: "m_admin", reason: "manual", active: true });
}

beforeEach(() => {
  resetDb();
  seed();
});

describe("listTeam", () => {
  it("lists members with user, normalised role, permissions, active assignments and Telegram link, ordered by role", async () => {
    const team = await listTeam("w1");
    expect(team.map((m) => m.id)).toEqual(["m_owner", "m_admin", "m_op", "m_legacy"]);
    expect(team[0]).toMatchObject({ name: "Egasi", email: "owner@example.com", role: "OWNER", roleLabel: "Egasi", activeAssignments: 0, telegramLinked: false });
    expect(team[1]).toMatchObject({ role: "ADMIN", activeAssignments: 1, permissions: permissionsOf("ADMIN") });
    expect(team[2]).toMatchObject({ name: null, email: "op@example.com", role: "OPERATOR", normalizedRole: "OPERATOR", activeAssignments: 2, telegramLinked: true });
    expect(team[3]).toMatchObject({ role: "MEMBER", normalizedRole: "OPERATOR", roleLabel: "Operator", permissions: ["view_contacts", "assign_leads", "view_analytics"] });
    expect(await listTeam("w2")).toHaveLength(1);
  });
});

describe("setMemberRole", () => {
  it("OWNER may set any non-owner member to ADMIN / MANAGER / OPERATOR / VIEWER", async () => {
    expect((await setMemberRole("w1", "OWNER", "m_op", "MANAGER")).role).toBe("MANAGER");
    expect((await setMemberRole("w1", "OWNER", "m_admin", "viewer")).role).toBe("VIEWER");
    expect((await setMemberRole("w1", "OWNER", "m_legacy", "ADMIN")).role).toBe("ADMIN");
    expect((await setMemberRole("w1", "OWNER", "m_legacy", "OPERATOR")).role).toBe("OPERATOR");
  });

  it("the OWNER's role never changes and nobody becomes OWNER", async () => {
    await expect(setMemberRole("w1", "OWNER", "m_owner", "ADMIN")).rejects.toMatchObject({ status: 422 });
    await expect(setMemberRole("w1", "OWNER", "m_op", "OWNER")).rejects.toMatchObject({ status: 422 });
    await expect(setMemberRole("w1", "ADMIN", "m_owner", "VIEWER")).rejects.toMatchObject({ status: 422 });
    expect(db.rows("workspaceMember").find((m) => m.id === "m_owner")!.role).toBe("OWNER");
  });

  it("ADMIN changes roles below ADMIN but not another ADMIN, and cannot grant ADMIN", async () => {
    expect((await setMemberRole("w1", "ADMIN", "m_op", "MANAGER")).role).toBe("MANAGER");
    db.seed("workspaceMember", { id: "m_admin2", workspaceId: "w1", userId: "u_x", role: "ADMIN" });
    await expect(setMemberRole("w1", "ADMIN", "m_admin2", "VIEWER")).rejects.toMatchObject({ status: 403 });
    await expect(setMemberRole("w1", "ADMIN", "m_op", "ADMIN")).rejects.toMatchObject({ status: 403 });
  });

  it("MANAGER, OPERATOR, MEMBER and VIEWER get 403", async () => {
    for (const actor of ["MANAGER", "OPERATOR", "MEMBER", "VIEWER", "", "nope"]) {
      await expect(setMemberRole("w1", actor, "m_op", "VIEWER"), actor).rejects.toMatchObject({ status: 403 });
    }
    expect(db.rows("workspaceMember").find((m) => m.id === "m_op")!.role).toBe("OPERATOR");
  });

  it("is workspace-scoped and validates the role value", async () => {
    await expect(setMemberRole("w1", "OWNER", "m_other", "VIEWER")).rejects.toMatchObject({ status: 404 });
    await expect(setMemberRole("w1", "OWNER", "m_op", "SUPERUSER")).rejects.toMatchObject({ status: 422 });
    await expect(setMemberRole("w1", "OWNER", "m_op", "MEMBER")).rejects.toMatchObject({ status: 422 });
    await expect(setMemberRole("w1", "OWNER", "m_op", 42)).rejects.toMatchObject({ status: 422 });
  });

  it("permissionsOf is the matrix passthrough", () => {
    expect(permissionsOf("VIEWER")).toEqual(["view_contacts", "view_analytics"]);
    expect(permissionsOf("MEMBER")).toEqual(permissionsOf("OPERATOR"));
  });
});
