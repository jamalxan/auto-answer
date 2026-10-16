/**
 * ETAP 9.3 — referral codes: alphabet, uniqueness, idempotency per referrer,
 * collision retry, ownership checks, link format and listing with counts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const randomBytes = vi.fn((size: number) => actual.randomBytes(size));
  return { ...actual, default: { ...actual, randomBytes }, randomBytes };
});

import { randomBytes } from "node:crypto";
import { CODE_ALPHABET, CODE_LENGTH, codeFromRef, createReferralCode, generateCode, listCodes, referralLink } from "../lib/engagement/referral/codes";
import { db, resetDb } from "./helpers/db-instance";

function seed() {
  db.seed("workspace", { id: "w1", ownerId: "u1" });
  db.seed("workspace", { id: "w2", ownerId: "u2" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig_shop" });
  db.seed("instagramAccount", { id: "a2", workspaceId: "w1", username: "other", instagramId: "ig_other" });
  db.seed("referralProgram", { id: "p1", workspaceId: "w1", instagramAccountId: "a1", name: "Do'st taklif" });
  db.seed("crmContact", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_ali", username: "ali" });
  db.seed("crmContact", { id: "c_other", workspaceId: "w1", instagramAccountId: "a2", igUserId: "ig_vali", username: "vali" });
}

beforeEach(() => {
  resetDb();
  seed();
  vi.mocked(randomBytes).mockClear();
});

describe("generateCode", () => {
  it("uses 6 characters of the unambiguous alphabet (no 0/O/1/I)", () => {
    expect(CODE_ALPHABET).toBe("23456789ABCDEFGHJKLMNPQRSTUVWXYZ");
    for (let i = 0; i < 300; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    }
  });

  it("maps random bytes onto the alphabet without bias", () => {
    // 256 is a multiple of 32: every byte maps to a character, none needs rejecting.
    vi.mocked(randomBytes).mockImplementationOnce((() => Buffer.from([0, 1, 31, 32, 63, 255, 0, 0, 0, 0, 0, 0])) as never);
    expect(generateCode()).toBe("23Z2ZZ");
  });

  it("does not repeat in a few hundred draws", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateCode()));
    expect(codes.size).toBe(200);
  });
});

describe("referralLink / codeFromRef", () => {
  it("builds the ig.me link with the rf_ prefix", () => {
    expect(referralLink("shop", "AB23CD")).toBe("https://ig.me/m/shop?ref=rf_AB23CD");
    expect(referralLink("@shop", "AB23CD")).toBe("https://ig.me/m/shop?ref=rf_AB23CD");
  });

  it("reads a ref back case-insensitively and rejects non-referral refs", () => {
    expect(codeFromRef("rf_ab23cd")).toBe("AB23CD");
    expect(codeFromRef("RF_AB23CD")).toBe("AB23CD");
    expect(codeFromRef("yozgi-aksiya")).toBeNull();
    expect(codeFromRef("rf_")).toBeNull();
    expect(codeFromRef("rf_a b")).toBeNull();
    expect(codeFromRef(null)).toBeNull();
  });
});

describe("createReferralCode", () => {
  it("is idempotent per (program, igUserId)", async () => {
    const first = await createReferralCode("w1", "p1", { igUserId: "ig_ali" });
    const second = await createReferralCode("w1", "p1", { igUserId: "ig_ali" });
    expect(second.id).toBe(first.id);
    expect(second.code).toBe(first.code);
    expect(db.rows("referralCode")).toHaveLength(1);
    expect(first).toMatchObject({ programId: "p1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_ali", contactId: "c1" });
  });

  it("resolves igUserId from the contact and returns the same code for either input", async () => {
    const byContact = await createReferralCode("w1", "p1", { contactId: "c1" });
    expect(byContact.igUserId).toBe("ig_ali");
    const byIg = await createReferralCode("w1", "p1", { igUserId: "ig_ali" });
    expect(byIg.id).toBe(byContact.id);
  });

  it("gives different people different codes and leaves contactId empty for an unknown person", async () => {
    const a = await createReferralCode("w1", "p1", { igUserId: "ig_ali" });
    const b = await createReferralCode("w1", "p1", { igUserId: "ig_zafar" });
    expect(a.code).not.toBe(b.code);
    expect(b.contactId).toBeNull();
  });

  it("retries when the random code collides", async () => {
    db.seed("referralCode", { id: "taken", programId: "p1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_old", code: "AAAAAA" });
    // 8 is the index of "A"; the first draw is AAAAAA (taken), the next ones are real randomness.
    vi.mocked(randomBytes).mockImplementationOnce(((size: number) => Buffer.alloc(size, 8)) as never);
    const row = await createReferralCode("w1", "p1", { igUserId: "ig_ali" });
    expect(row.code).not.toBe("AAAAAA");
    expect(row.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  });

  it("rejects a contact of another account, another workspace, a missing program and an empty input", async () => {
    await expect(createReferralCode("w1", "p1", { contactId: "c_other" })).rejects.toMatchObject({ status: 404 });
    await expect(createReferralCode("w2", "p1", { igUserId: "ig_ali" })).rejects.toMatchObject({ status: 404 });
    await expect(createReferralCode("w1", "nope", { igUserId: "ig_ali" })).rejects.toMatchObject({ status: 404 });
    await expect(createReferralCode("w1", "p1", {})).rejects.toMatchObject({ status: 422 });
    await expect(createReferralCode("w1", "p1", { contactId: "c1", igUserId: "someone_else" })).rejects.toMatchObject({ status: 422 });
  });
});

describe("listCodes", () => {
  it("lists with event counts and pages with a cursor", async () => {
    const a = await createReferralCode("w1", "p1", { igUserId: "ig_ali" });
    await createReferralCode("w1", "p1", { igUserId: "ig_b" });
    await createReferralCode("w1", "p1", { igUserId: "ig_c" });
    db.seed("referralEvent", { programId: "p1", workspaceId: "w1", codeId: a.id, referrerIgUserId: "ig_ali", refereeIgUserId: "f1", sourceEventId: "e1", status: "REWARDED" });
    db.seed("referralEvent", { programId: "p1", workspaceId: "w1", codeId: a.id, referrerIgUserId: "ig_ali", refereeIgUserId: "f2", sourceEventId: "e2", status: "PENDING" });

    const page1 = await listCodes("w1", "p1", { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listCodes("w1", "p1", { limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const all = await listCodes("w1", "p1", { limit: 10 });
    const mine = all.items.find((item) => item.id === a.id)!;
    expect(mine).toMatchObject({ events: 2, qualified: 1, rewarded: 1, username: "ali" });
  });
});
