import { beforeEach, describe, expect, it, vi } from "vitest";
import { scryptSync } from "crypto";

type Row = { id: string; username: string; email: string; passwordHash: string };
const rows: Row[] = [];

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    adminAccount: {
      count: vi.fn(async () => rows.length),
      findUnique: vi.fn(async ({ where }: { where: { username?: string; id?: string } }) =>
        rows.find((r) => (where.username !== undefined ? r.username === where.username : r.id === where.id)) ?? null
      ),
      findMany: vi.fn(async ({ where, take }: { where: { email: { equals: string } }; take: number }) =>
        rows.filter((r) => r.email.toLowerCase() === where.email.equals.toLowerCase()).slice(0, take)
      ),
    },
  },
}));

import { verifyAdminCredentials } from "@/lib/admin/auth";

function hash(password: string): string {
  const salt = "0123456789abcdef";
  return `${salt}:${scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex")}`;
}

describe("verifyAdminCredentials", () => {
  beforeEach(() => {
    rows.length = 0;
    delete process.env.ADMIN_INITIAL_PASSWORD;
    rows.push({ id: "a1", username: "admin", email: "Owner@Example.com", passwordHash: hash("correct-horse-1") });
  });

  it("accepts the username", async () => {
    expect(await verifyAdminCredentials("admin", "correct-horse-1")).toMatchObject({ id: "a1" });
  });

  it("accepts the email, case-insensitive and trimmed", async () => {
    expect(await verifyAdminCredentials("  owner@example.com ", "correct-horse-1")).toMatchObject({ id: "a1" });
  });

  it("rejects a wrong password whether the login is a username or an email", async () => {
    expect(await verifyAdminCredentials("admin", "nope")).toBeNull();
    expect(await verifyAdminCredentials("owner@example.com", "nope")).toBeNull();
  });

  it("rejects an unknown login and an empty one", async () => {
    expect(await verifyAdminCredentials("nobody@example.com", "correct-horse-1")).toBeNull();
    expect(await verifyAdminCredentials("   ", "correct-horse-1")).toBeNull();
  });

  it("does not guess when two accounts share the email", async () => {
    rows.push({ id: "a2", username: "second", email: "owner@example.com", passwordHash: hash("correct-horse-1") });
    expect(await verifyAdminCredentials("owner@example.com", "correct-horse-1")).toBeNull();
    expect(await verifyAdminCredentials("second", "correct-horse-1")).toMatchObject({ id: "a2" });
  });
});
