/**
 * ETAP 5.1 — tags: CRUD per workspace, idempotent add / remove with
 * activity rows, lazy defaults, and the automatic tags the listener writes
 * from CRM events (campaign / ad / link / handoff / temperature / extracted).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import type { CrmContact } from "../app/generated/prisma/client";
import { DEFAULT_TAGS } from "../lib/crm/defaults";
import { CrmServiceError } from "../lib/crm/errors";
import { clearCrmListeners, emitCrmEvent, type CrmEvent } from "../lib/crm/hooks";
import {
  addTag,
  applyTemperatureTag,
  createTag,
  deleteTag,
  ensureDefaultTags,
  listTags,
  namespacedTag,
  registerTagListeners,
  removeTag,
  tagsOfContact,
  updateTag,
} from "../lib/crm/tags";
import { db, resetDb } from "./helpers/db-instance";

function seed() {
  db.seed("workspace", { id: "w1", ownerId: "u1", name: "Mebel" });
  db.seed("workspace", { id: "w2", ownerId: "u2", name: "Boshqa" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "mebel", instagramId: "ig1" });
  db.seed("crmContact", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_u1", username: "ali" });
  db.seed("crmContact", { id: "c2", workspaceId: "w2", instagramAccountId: "a2", igUserId: "ig_u2", username: "vali" });
}

const contact = (id = "c1") => db.rows("crmContact").find((row) => row.id === id) as unknown as CrmContact;
const activities = (type?: string) => db.rows("crmActivity").filter((a) => !type || a.type === type);
const base = () => ({ workspaceId: "w1", contactId: "c1", contact: contact() });

beforeEach(() => {
  resetDb();
  seed();
  // The module registers on import; tests that import several CRM modules share the registry.
  clearCrmListeners();
  registerTagListeners();
});

describe("tag CRUD", () => {
  it("creates with a slug, rejects a duplicate slug with 422 and lists with counts", async () => {
    const tag = await createTag("w1", { name: "To'lov  kutilmoqda", color: "#F97316" });
    expect(tag).toMatchObject({ slug: "tolov-kutilmoqda", workspaceId: "w1" });
    await expect(createTag("w1", { name: "TOLOV KUTILMOQDA" })).rejects.toMatchObject({ status: 422 });
    // Same slug in another workspace is fine.
    await expect(createTag("w2", { name: "To'lov kutilmoqda" })).resolves.toMatchObject({ slug: "tolov-kutilmoqda" });
    await addTag("w1", "c1", tag.id, "MANUAL");
    const list = await listTags("w1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ slug: "tolov-kutilmoqda", contactCount: 1 });
  });

  it("validates the input (empty name, bad colour, symbol-only name)", async () => {
    await expect(createTag("w1", { name: "" })).rejects.toBeInstanceOf(CrmServiceError);
    await expect(createTag("w1", { name: "x", color: "red" })).rejects.toMatchObject({ status: 422 });
    await expect(createTag("w1", { name: "!!!" })).rejects.toMatchObject({ status: 422 });
  });

  it("renames (new slug, duplicate check) and recolours; other workspaces read as 404", async () => {
    const a = await createTag("w1", { name: "VIP" });
    await createTag("w1", { name: "HOT" });
    await expect(updateTag("w1", a.id, { name: "hot" })).rejects.toMatchObject({ status: 422 });
    const renamed = await updateTag("w1", a.id, { name: "Super VIP", color: "#000000" });
    expect(renamed).toMatchObject({ name: "Super VIP", slug: "super-vip", color: "#000000" });
    await expect(updateTag("w2", a.id, { name: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteTag("w2", a.id)).rejects.toMatchObject({ status: 404 });
  });

  it("deletes the tag together with its contact links", async () => {
    const tag = await createTag("w1", { name: "VIP" });
    await addTag("w1", "c1", "vip", "MANUAL");
    expect(db.rows("crmContactTag")).toHaveLength(1);
    await deleteTag("w1", tag.id);
    expect(db.rows("crmTag")).toHaveLength(0);
    expect(db.rows("crmContactTag")).toHaveLength(0);
  });

  it("seeds the defaults lazily and idempotently", async () => {
    expect(await ensureDefaultTags("w1")).toBe(DEFAULT_TAGS.length);
    expect(await ensureDefaultTags("w1")).toBe(0);
    expect((await listTags("w1")).map((t) => t.slug).sort()).toEqual(DEFAULT_TAGS.map((t) => t.slug).sort());
    // A workspace that already has one of them only gets the missing ones.
    await createTag("w2", { name: "HOT" });
    expect(await ensureDefaultTags("w2")).toBe(DEFAULT_TAGS.length - 1);
  });
});

describe("addTag / removeTag", () => {
  it("is idempotent and writes exactly one TAG_ADDED / TAG_REMOVED activity per real change", async () => {
    await createTag("w1", { name: "VIP" });
    const first = await addTag("w1", "c1", "vip", "MANUAL", null, "m1");
    const second = await addTag("w1", "c1", "VIP", "MANUAL", null, "m1");
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(db.rows("crmContactTag")).toHaveLength(1);
    expect(activities("TAG_ADDED")).toHaveLength(1);
    expect(activities("TAG_ADDED")[0]).toMatchObject({
      contactId: "c1",
      workspaceId: "w1",
      actorKind: "OPERATOR",
      actorMemberId: "m1",
      title: "Teg qo'shildi: VIP",
      payload: { slug: "vip", origin: "MANUAL" },
    });

    const tags = await tagsOfContact("c1");
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ slug: "vip", origin: "MANUAL" });

    expect((await removeTag("w1", "c1", "vip", "m1")).changed).toBe(true);
    expect((await removeTag("w1", "c1", "vip", "m1")).changed).toBe(false);
    expect(activities("TAG_REMOVED")).toHaveLength(1);
    expect(await tagsOfContact("c1")).toEqual([]);
  });

  it("records the origin and sourceRef, and lets a manual removal drop an AI tag", async () => {
    await createTag("w1", { name: "HOT" });
    await addTag("w1", "c1", "hot", "AI", "ai:temperature");
    expect(db.rows("crmContactTag")[0]).toMatchObject({ origin: "AI", sourceRef: "ai:temperature" });
    expect((await removeTag("w1", "c1", "hot", "m1")).changed).toBe(true);
  });

  it("is workspace-scoped: foreign contact or tag → 404", async () => {
    const tag = await createTag("w1", { name: "VIP" });
    await expect(addTag("w1", "c2", tag.id, "MANUAL")).rejects.toMatchObject({ status: 404 });
    await expect(addTag("w2", "c2", tag.id, "MANUAL")).rejects.toMatchObject({ status: 404 });
    await expect(addTag("w1", "c1", "nope", "MANUAL")).rejects.toMatchObject({ status: 404 });
  });
});

describe("automatic tags (listener)", () => {
  const interaction = (payload: Record<string, unknown> | null): CrmEvent => ({
    ...base(),
    kind: "interaction",
    direction: "inbound",
    via: "inbound",
    at: new Date(),
    payload,
  });

  it("campaign name, 'reklama' and 'havola:<ref>' from an interaction payload", async () => {
    db.seed("triggerCampaign", { id: "camp1", workspaceId: "w1", instagramAccountId: "a1", name: "Yozgi aksiya", triggerType: "COMMENT", responseMessage: "x" });
    await emitCrmEvent(interaction({ claimedCampaignId: "camp1", adId: "ad_9", ref: "Story Link" }));
    const slugs = (await tagsOfContact("c1")).map((t) => t.slug).sort();
    expect(slugs).toEqual(["havola:story-link", "reklama", "yozgi-aksiya"].sort());
    const tags = db.rows("crmTag");
    expect(tags.find((t) => t.slug === "yozgi-aksiya")).toMatchObject({ name: "Yozgi aksiya", workspaceId: "w1" });
    expect(tags.find((t) => t.slug === "reklama")).toMatchObject({ name: "Reklama" });
    expect(db.rows("crmContactTag").every((link) => link.origin === "AUTOMATION")).toBe(true);
    expect(db.rows("crmContactTag").find((l) => l.sourceRef === "campaign:camp1")).toBeTruthy();
    // Same facts again (campaignName inline this time): nothing new.
    await emitCrmEvent(interaction({ campaignId: "camp1", campaignName: "Yozgi aksiya", adId: "ad_9", ref: "Story Link" }));
    expect(db.rows("crmContactTag")).toHaveLength(3);
    expect(activities("TAG_ADDED")).toHaveLength(3);
  });

  it("'handoff' on HANDOFF_OPENED only", async () => {
    await emitCrmEvent({ ...base(), kind: "handoff", state: "HANDOFF_ACCEPTED", conversationId: "conv1", handoffId: "h1" });
    expect(db.rows("crmContactTag")).toHaveLength(0);
    await emitCrmEvent({ ...base(), kind: "handoff", state: "HANDOFF_OPENED", conversationId: "conv1", handoffId: "h1" });
    expect((await tagsOfContact("c1")).map((t) => t.slug)).toEqual(["handoff"]);
    expect(db.rows("crmTag")[0]).toMatchObject({ name: "Operatorga o'tgan", slug: "handoff" });
  });

  it("temperature band replaces the previous band tag; CUSTOMER clears it", async () => {
    const score = (previousTemperature: "COLD" | "WARM" | "HOT", temperature: "COLD" | "WARM" | "HOT"): CrmEvent => ({
      ...base(),
      kind: "score",
      score: 50,
      previousScore: 10,
      temperature,
      previousTemperature,
      becameHot: temperature === "HOT" && previousTemperature !== "HOT",
    });
    await emitCrmEvent(score("COLD", "WARM"));
    expect((await tagsOfContact("c1")).map((t) => t.slug)).toEqual(["iliq"]);
    await emitCrmEvent(score("WARM", "HOT"));
    expect((await tagsOfContact("c1")).map((t) => t.slug)).toEqual(["hot"]);
    expect(db.rows("crmContactTag")[0]).toMatchObject({ origin: "AI", sourceRef: "ai:temperature" });
    // Unchanged temperature: no churn.
    await emitCrmEvent(score("HOT", "HOT"));
    expect(activities("TAG_ADDED")).toHaveLength(2);
    await applyTemperatureTag("w1", "c1", "CUSTOMER");
    expect(await tagsOfContact("c1")).toEqual([]);
    expect(activities("TAG_REMOVED")).toHaveLength(2);
  });

  it("'mahsulot:<slug>' / 'joy:<slug>' from AiConversationState.extracted on score and lead events", async () => {
    db.seed("conversation", { id: "conv1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ig_u1" });
    db.rows("crmContact")[0].conversationId = "conv1";
    db.seed("aiConversationState", { conversationId: "conv1", extracted: { product: "IELTS kursi", location: "Toshkent", budget: "500" } });
    await emitCrmEvent({ ...base(), kind: "score", score: 40, previousScore: 30, temperature: "WARM", previousTemperature: "WARM", becameHot: false });
    const tags = await tagsOfContact("c1");
    expect(tags.map((t) => t.slug).sort()).toEqual(["joy:toshkent", "mahsulot:ielts-kursi"]);
    expect(tags.find((t) => t.slug === "mahsulot:ielts-kursi")).toMatchObject({ name: "Mahsulot: IELTS kursi", origin: "AI", sourceRef: "ai:extracted.product" });
    expect(tags.find((t) => t.slug === "joy:toshkent")).toMatchObject({ name: "Joy: Toshkent", sourceRef: "ai:extracted.location" });

    db.rows("aiConversationState")[0].extracted = { product: "Mebel" };
    await emitCrmEvent({ ...base(), kind: "lead_created", leadId: "l1", dealId: "d1", productInterest: "Mebel" });
    expect((await tagsOfContact("c1")).map((t) => t.slug)).toContain("mahsulot:mebel");
  });

  it("namespacedTag normalises Cyrillic and apostrophes into the slug", () => {
    expect(namespacedTag("joy", "Тошкент")).toEqual({ name: "Joy: Тошкент", slug: "joy:toshkent" });
    expect(namespacedTag("mahsulot", "O'quv kursi")).toEqual({ name: "Mahsulot: O'quv kursi", slug: "mahsulot:oquv-kursi" });
    expect(namespacedTag("joy", "???")).toBeNull();
  });

  it("ignores events without any taggable fact", async () => {
    await emitCrmEvent(interaction({ text: "salom" }));
    await emitCrmEvent(interaction(null));
    expect(db.rows("crmTag")).toHaveLength(0);
    expect(db.rows("crmContactTag")).toHaveLength(0);
  });
});
