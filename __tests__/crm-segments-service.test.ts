/**
 * ETAP 5.1 — segments on the DB: CRUD, preview (count == items), the
 * cached count, the described filter with real names, and the CSV export
 * through the same `where`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});

import { CrmServiceError } from "../lib/crm/errors";
import { exportContactsCsv } from "../lib/crm/export";
import { compileSegmentWhere, type SegmentFilter } from "../lib/crm/segments";
import {
  createSegment,
  deleteSegment,
  describeSegment,
  describeSegments,
  listSegments,
  loadDescribeNames,
  previewSegment,
  refreshSegmentCount,
  segmentWhere,
  updateSegment,
} from "../lib/crm/segments-service";
import { db, resetDb } from "./helpers/db-instance";

const NOW = new Date("2026-10-16T12:00:00Z");

/** The design's example: HOT + phone + joy:toshkent + mahsulot:ielts. */
const DESIGN_FILTER: SegmentFilter = {
  v: 1,
  all: [
    { field: "tag", op: "eq", value: "hot" },
    { field: "phone_present", op: "is_true" },
    { field: "tag", op: "eq", value: "joy:toshkent" },
    { field: "tag", op: "eq", value: "mahsulot:ielts" },
  ],
};

function tag(workspaceId: string, slug: string, name = slug) {
  return db.seed("crmTag", { workspaceId, slug, name });
}

function link(contactId: string, tagId: string, origin = "AI") {
  db.seed("crmContactTag", { contactId, tagId, origin });
}

function seed() {
  db.seed("workspace", { id: "w1", ownerId: "u1", name: "Edu" });
  db.seed("workspace", { id: "w2", ownerId: "u2", name: "Boshqa" });
  db.seed("user", { id: "u1", name: "Aziza", email: "aziza@example.com" });
  db.seed("workspaceMember", { id: "m1", workspaceId: "w1", userId: "u1", role: "OWNER" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "eduschool", instagramId: "ig1" });
  const hot = tag("w1", "hot", "HOT");
  const toshkent = tag("w1", "joy:toshkent", "Joy: Toshkent");
  const ielts = tag("w1", "mahsulot:ielts", "Mahsulot: IELTS");
  const samarkand = tag("w1", "joy:samarqand", "Joy: Samarqand");

  const contacts = [
    // Matches everything.
    { id: "c1", username: "ali", phoneE164: "+998901112233", temperature: "HOT", score: 80, hasAiState: true, tags: [hot, toshkent, ielts], last: 1 },
    { id: "c2", username: "vali", phoneE164: "+998901112244", temperature: "HOT", score: 75, hasAiState: true, tags: [hot, toshkent, ielts], last: 2 },
    // No phone.
    { id: "c3", username: "guli", phoneE164: null, temperature: "HOT", score: 70, hasAiState: true, tags: [hot, toshkent, ielts], last: 3 },
    // Samarqand.
    { id: "c4", username: "nodir", phoneE164: "+998901112255", temperature: "HOT", score: 90, hasAiState: true, tags: [hot, samarkand, ielts], last: 4 },
    // Not hot.
    { id: "c5", username: "lola", phoneE164: "+998901112266", temperature: "WARM", score: 40, hasAiState: true, tags: [toshkent, ielts], last: 5 },
    // Everything but in another workspace.
    { id: "c6", username: "other", phoneE164: "+998901112277", temperature: "HOT", score: 80, hasAiState: true, tags: [], last: 6, workspaceId: "w2" },
  ];
  for (const c of contacts) {
    db.seed("crmContact", {
      id: c.id,
      workspaceId: c.workspaceId ?? "w1",
      instagramAccountId: c.workspaceId ? "a2" : "a1",
      igUserId: `ig_${c.id}`,
      username: c.username,
      name: null,
      phoneE164: c.phoneE164,
      temperature: c.temperature,
      score: c.score,
      hasAiState: c.hasAiState,
      lastInteractionAt: new Date(NOW.getTime() - c.last * 3600_000),
      assignedMemberId: c.id === "c1" ? "m1" : null,
    });
    for (const t of c.tags) link(c.id, t.id as string);
  }
  // w2 has its own "hot" tag on c6: must never leak into w1 results.
  const otherHot = tag("w2", "hot", "HOT");
  link("c6", otherHot.id as string);
}

beforeEach(() => {
  resetDb();
  seed();
});

describe("previewSegment", () => {
  it("'HOT + phone + joy:toshkent + mahsulot:ielts' returns exactly the expected contacts, count == items.length", async () => {
    const preview = await previewSegment("w1", DESIGN_FILTER, { now: NOW });
    expect(preview.count).toBe(2);
    expect(preview.items).toHaveLength(preview.count);
    expect(preview.items.map((i) => i.id)).toEqual(["c1", "c2"]); // most recent interaction first
    expect(preview.items[0]).toMatchObject({ username: "ali", phoneE164: "+998901112233", temperature: "HOT", assignedMemberId: "m1" });
    expect(preview.items[0].tags.sort()).toEqual(["hot", "joy:toshkent", "mahsulot:ielts"]);
  });

  it("respects the limit while the count stays total", async () => {
    const preview = await previewSegment("w1", { v: 1, all: [{ field: "tag", op: "eq", value: "hot" }] }, { limit: 2, now: NOW });
    expect(preview.count).toBe(4);
    expect(preview.items).toHaveLength(2);
    expect(preview.limit).toBe(2);
  });

  it("an empty filter is every contact of the workspace, never another workspace's", async () => {
    const preview = await previewSegment("w1", { v: 1, all: [] }, { now: NOW });
    expect(preview.count).toBe(5);
    expect(preview.items.map((i) => i.id)).not.toContain("c6");
  });

  it("rejects an invalid filter with 422", async () => {
    await expect(previewSegment("w1", { v: 1, all: [{ field: "nope", op: "eq", value: 1 }] })).rejects.toMatchObject({ status: 422 });
    await expect(previewSegment("w1", null)).rejects.toBeInstanceOf(CrmServiceError);
  });

  it("segmentWhere adds the workspace and excludes merged contacts", () => {
    expect(segmentWhere("w1", DESIGN_FILTER, NOW)).toEqual({ workspaceId: "w1", mergedIntoId: null, ...compileSegmentWhere(DESIGN_FILTER, NOW) });
  });
});

describe("segment CRUD", () => {
  it("creates with a cached count, lists, updates (recount) and deletes", async () => {
    const created = await createSegment("w1", { name: "Toshkent IELTS HOT", filter: DESIGN_FILTER }, "u1");
    expect(created).toMatchObject({ name: "Toshkent IELTS HOT", lastCount: 2, createdByUserId: "u1" });
    expect(created.filter).toEqual(DESIGN_FILTER);
    expect(await listSegments("w1")).toHaveLength(1);
    expect(await listSegments("w2")).toHaveLength(0);

    const updated = await updateSegment("w1", created.id, { filter: { v: 1, all: [{ field: "tag", op: "eq", value: "hot" }] }, description: "Hot" });
    expect(updated).toMatchObject({ lastCount: 4, description: "Hot" });
    await expect(updateSegment("w2", created.id, { name: "x" })).rejects.toMatchObject({ status: 404 });

    await deleteSegment("w1", created.id);
    expect(db.rows("crmSegment")).toHaveLength(0);
  });

  it("validates name and filter with 422", async () => {
    await expect(createSegment("w1", { name: "", filter: DESIGN_FILTER })).rejects.toMatchObject({ status: 422 });
    await expect(createSegment("w1", { name: "x", filter: { v: 1, all: [{ field: "score", op: "gte", value: "70" }] } })).rejects.toMatchObject({ status: 422 });
  });

  it("refuses to delete a segment referenced by a SCHEDULED / RUNNING broadcast", async () => {
    const segment = await createSegment("w1", { name: "S", filter: DESIGN_FILTER });
    const broadcast = db.seed("crmBroadcast", { workspaceId: "w1", instagramAccountId: "a1", name: "B", segmentId: segment.id, audienceFilter: DESIGN_FILTER, message: "hi", status: "SCHEDULED" });
    await expect(deleteSegment("w1", segment.id)).rejects.toMatchObject({ status: 422 });
    broadcast.status = "RUNNING";
    await expect(deleteSegment("w1", segment.id)).rejects.toMatchObject({ status: 422 });
    broadcast.status = "COMPLETED";
    await deleteSegment("w1", segment.id);
    expect(db.rows("crmSegment")).toHaveLength(0);
  });

  it("refreshSegmentCount recounts after the data changed", async () => {
    const segment = await createSegment("w1", { name: "S", filter: DESIGN_FILTER });
    expect(segment.lastCount).toBe(2);
    db.rows("crmContact").find((c) => c.id === "c2")!.phoneE164 = null;
    expect(await refreshSegmentCount(segment.id, NOW)).toBe(1);
    expect(db.rows("crmSegment")[0]).toMatchObject({ lastCount: 1 });
    expect(db.rows("crmSegment")[0].lastCountedAt).toEqual(NOW);
    await expect(refreshSegmentCount("nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("describeSegment", () => {
  it("renders tag, member, account and stage names instead of ids", async () => {
    const pipeline = db.seed("crmPipeline", { workspaceId: "w1", name: "Asosiy voronka", isDefault: true });
    const stage = db.seed("crmStage", { pipelineId: pipeline.id, name: "Muzokara", sort: 4 });
    const filter: SegmentFilter = {
      v: 1,
      all: [
        { field: "tag", op: "eq", value: "hot" },
        { field: "assigned", op: "eq", value: "m1" },
        { field: "account", op: "eq", value: "a1" },
        { field: "stage", op: "eq", value: stage.id as string },
        { field: "pipeline", op: "eq", value: pipeline.id as string },
      ],
    };
    const names = await loadDescribeNames("w1");
    expect(describeSegment({ filter }, names)).toBe("Teg: HOT va Operator: Aziza va Akkaunt: @eduschool va Bosqich: Muzokara va Voronka: Asosiy voronka");
    const segment = await createSegment("w1", { name: "S", filter });
    expect(await describeSegments("w1", [segment])).toEqual({ [segment.id]: "Teg: HOT va Operator: Aziza va Akkaunt: @eduschool va Bosqich: Muzokara va Voronka: Asosiy voronka" });
  });
});

describe("exportContactsCsv", () => {
  it("exports the segment's rows with the documented columns and escapes formulas", async () => {
    const contact = db.rows("crmContact").find((c) => c.id === "c1")!;
    contact.name = "=HYPERLINK(\"http://evil\")";
    contact.email = "ali@example.com";
    contact.language = "uz";
    contact.source = "COMMENT";
    contact.firstInteractionAt = new Date("2026-10-01T10:00:00Z");
    db.rows("crmContact").find((c) => c.id === "c2")!.name = "Vali, \"Jr\"";

    const csv = await exportContactsCsv("w1", compileSegmentWhere(DESIGN_FILTER, NOW));
    const lines = csv.split("\n");
    expect(lines[0]).toBe("username,name,phone,email,language,status,temperature,score,tags,assigned,source,firstInteraction,lastInteraction");
    expect(lines).toHaveLength(3);
    const ali = lines.find((line) => line.startsWith("ali,"))!;
    expect(ali).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(ali).toContain("+998901112233"); // a phone is not a formula
    expect(ali).toContain("ali@example.com,uz,Yangi,Hot,80,");
    expect(ali).toContain("HOT; Joy: Toshkent; Mahsulot: IELTS");
    expect(ali).toContain(",Aziza,Izoh,2026-10-01T10:00:00.000Z,");
    expect(lines.find((line) => line.startsWith("vali,"))).toContain(`"Vali, ""Jr"""`);
  });

  it("never leaks another workspace and leaves score / temperature empty without AI state", async () => {
    db.rows("crmContact").find((c) => c.id === "c5")!.hasAiState = false;
    const csv = await exportContactsCsv("w1");
    expect(csv).not.toContain("other,");
    expect(csv.split("\n")).toHaveLength(6);
    expect(csv.split("\n").find((line) => line.startsWith("lola,"))).toContain(",Yangi,,,");
  });
});
