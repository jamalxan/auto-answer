import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("REDIS_URL", "redis://localhost:6379");

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/assistant-queue", () => ({
  enqueueDelivery: vi.fn(async () => {}),
  enqueueNotify: vi.fn(async () => {}),
  scheduleReply: vi.fn(async () => {}),
}));

import { enqueueLeadDeliveries } from "../lib/leads/delivery";
import { buildLeadWhere } from "../lib/leads/query";
import {
  classifyLead,
  isTestLeadName,
  normalizeLeadPhone,
  validateLeadName,
} from "../lib/leads/validate";
import { sanitizeName } from "../lib/assistant/turn";
import { db, resetDb } from "./helpers/db-instance";

describe("validateLeadName", () => {
  it.each([
    "salom", "Assalomu alaykum", "привет", "Hi", "hello", "narxi?", "qancha", "Narxi qancha?",
    "😀😀", "https://example.com", "shop.uz", "A", "x".repeat(50), "", null, "Здравствуйте",
  ])("rejects %j", (value) => {
    expect(validateLeadName(value as string | null)).toBeNull();
  });

  it.each([
    ["aziz", "Aziz"],
    ["Aziz Karimov", "Aziz Karimov"],
    ["Sevara 😊", "Sevara"],
    ["Ол'га", "Ол'Га"],
  ])("accepts %j", (value, expected) => {
    expect(validateLeadName(value)?.toLowerCase()).toBe(expected.toLowerCase());
  });

  it.each([
    ["Good Boy", "Good Boy"],
    ["Mr. Bor", "Mr. Bor"],
    ["Ali.", "Ali"],
    ["Ali Valiyev Aliyevich Oglu", "Ali Valiyev Aliyevich Oglu"],
  ])("keeps real-looking name %j", (value, expected) => {
    expect(validateLeadName(value)).toBe(expected);
  });

  it.each(["Salom salom", "Ali Valiyev Aliyevich Oglu Extra", "narxi qancha", "Hi."])("still rejects %j", (value) => {
    expect(validateLeadName(value)).toBeNull();
  });

  it("is used by the assistant's sanitizeName", () => {
    expect(sanitizeName("narxi?")).toBeNull();
    expect(sanitizeName("qancha")).toBeNull();
    expect(sanitizeName("aziz")).toBe("Aziz");
  });
});

describe("normalizeLeadPhone", () => {
  it.each([
    "901234567", "998901234567", "+998901234567", "+998 90 123-45-67", "(90) 123 45 67", "+998 (90) 123-45-67",
  ])("normalises %j to +998901234567", (value) => {
    expect(normalizeLeadPhone(value)).toMatchObject({ e164: "+998901234567", invalid: false });
  });

  it.each(["12345", "abc", "99890123", "+998 12 345"])("flags %j as invalid, keeping the raw text", (value) => {
    expect(normalizeLeadPhone(value)).toEqual({ e164: null, raw: value, invalid: true });
  });

  it.each(["0901234567", "0 90 123 45 67"])("accepts local trunk form %j", (value) => {
    expect(normalizeLeadPhone(value)).toMatchObject({ e164: "+998901234567", invalid: false });
  });

  it.each(["8 901 234 56 78", "89012345678", "7 901 234 56 78", "0123456789"])("does not silently map %j", (value) => {
    expect(normalizeLeadPhone(value)).toEqual({ e164: null, raw: value, invalid: true });
  });

  it("keeps an explicit +7 number", () => {
    expect(normalizeLeadPhone("+7 912 345 67 89").e164).toBe("+79123456789");
  });

  it("empty input is not invalid, just absent", () => {
    expect(normalizeLeadPhone("")).toEqual({ e164: null, raw: "", invalid: false });
  });
});

describe("classifyLead", () => {
  it("phone or buying interest makes a lead; otherwise a contact", () => {
    expect(classifyLead({ phoneE164: "+998901234567" })).toBe("LEAD");
    expect(classifyLead({ productInterest: "divan" })).toBe("LEAD");
    expect(classifyLead({})).toBe("CONTACT");
    expect(classifyLead({ phoneE164: null, productInterest: "  " })).toBe("CONTACT");
    expect(classifyLead({ productInterest: "?!" })).toBe("CONTACT");
  });

  it("detects the [TEST] name marker", () => {
    expect(isTestLeadName("[TEST] Sinov")).toBe(true);
    expect(isTestLeadName("Aziz")).toBe(false);
  });
});

describe("lead list defaults", () => {
  it("hides test leads unless asked, and filters by kind", () => {
    expect(buildLeadWhere("w1", {})).toMatchObject({ isTest: false });
    expect(buildLeadWhere("w1", { includeTest: true }).isTest).toBeUndefined();
    expect(buildLeadWhere("w1", { kind: "contact" })).toMatchObject({ kind: "CONTACT" });
    expect(buildLeadWhere("w1", { kind: "junk" }).kind).toBeUndefined();
  });
});

describe("delivery fan-out quality gates", () => {
  beforeEach(() => resetDb());

  function seed(leadExtra: Record<string, unknown>) {
    db.seed("workspace", { id: "w1" });
    db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig1" });
    db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
    db.seed("integration", { id: "int_amo", workspaceId: "w1", type: "AMOCRM", name: "amoCRM" });
    return db.seed("lead", {
      id: "l1", workspaceId: "w1", instagramAccountId: "a1", idempotencyKey: "c:0", igUserId: "u1",
      phoneE164: null, ...leadExtra,
    });
  }

  it("never sends a phoneless bare contact to amoCRM (Telegram still alerts)", async () => {
    const lead = seed({ kind: "CONTACT" });
    await enqueueLeadDeliveries(lead as never, "new");
    expect(db.rows("leadDelivery").map((d) => d.integrationId)).toEqual(["int_tg"]);
  });

  it("delivers a real lead to both", async () => {
    const lead = seed({ kind: "LEAD", phoneE164: "+998901234567" });
    await enqueueLeadDeliveries(lead as never, "new");
    expect(db.rows("leadDelivery")).toHaveLength(2);
  });

  it("never fans a test lead out to any integration", async () => {
    const lead = seed({ kind: "LEAD", phoneE164: "+998901234567", isTest: true });
    await enqueueLeadDeliveries(lead as never, "new");
    expect(db.rows("leadDelivery")).toHaveLength(0);
  });
});
