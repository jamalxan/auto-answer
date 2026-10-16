/**
 * ETAP 5.1 — segment filter DSL: schema, Prisma `where` compilation and the
 * Uzbek description. Pure functions only.
 */

import { describe, expect, it } from "vitest";
import {
  compileSegmentWhere,
  customFieldKey,
  describeFilter,
  EMPTY_FILTER,
  FIELD_SPECS,
  fieldSpec,
  parseSegmentFilter,
  SEGMENT_FIELDS,
  segmentFilterSchema,
  WINDOW_OPEN_MS,
  type SegmentCondition,
  type SegmentFilter,
} from "../lib/crm/segments";

const NOW = new Date("2026-10-16T12:00:00Z");
const DAY = 24 * 3600_000;

function filter(all: SegmentCondition[], any?: SegmentCondition[]): SegmentFilter {
  return { v: 1, all, ...(any ? { any } : {}) };
}

function compileOne(cond: SegmentCondition) {
  const where = compileSegmentWhere(filter([cond]), NOW) as { AND: unknown[] };
  return where.AND[0];
}

describe("segmentFilterSchema", () => {
  it("accepts the documented example (HOT + phone + Toshkent + IELTS)", () => {
    const parsed = segmentFilterSchema.safeParse({
      v: 1,
      all: [
        { field: "tag", op: "eq", value: "hot" },
        { field: "phone_present", op: "is_true" },
        { field: "custom.city", op: "eq", value: "Toshkent" },
        { field: "custom.course", op: "contains", value: "IELTS" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown fields, wrong operators and wrong value kinds", () => {
    expect(parseSegmentFilter({ v: 1, all: [{ field: "nope", op: "eq", value: "x" }] })).toBeNull();
    expect(parseSegmentFilter({ v: 1, all: [{ field: "tag", op: "gte", value: 3 }] })).toBeNull();
    expect(parseSegmentFilter({ v: 1, all: [{ field: "score", op: "gte", value: "70" }] })).toBeNull();
    expect(parseSegmentFilter({ v: 1, all: [{ field: "score", op: "gte" }] })).toBeNull();
    expect(parseSegmentFilter({ v: 1, all: [{ field: "temperature", op: "in", value: "HOT" }] })).toBeNull();
    expect(parseSegmentFilter({ v: 1, all: [{ field: "temperature", op: "eq", value: ["HOT"] }] })).toBeNull();
    expect(parseSegmentFilter({ v: 1, all: [{ field: "score", op: "in", value: ["a"] }] })).toBeNull();
    expect(parseSegmentFilter({ v: 1, all: [{ field: "last_interaction", op: "within_days", value: -1 }] })).toBeNull();
    expect(parseSegmentFilter({ v: 2, all: [] })).toBeNull();
    expect(parseSegmentFilter({ v: 1, all: [{ field: "custom.bad key", op: "eq", value: 1 }] })).toBeNull();
    expect(parseSegmentFilter({ v: 1, all: [{ field: "custom.1x", op: "eq", value: 1 }] })).toBeNull();
  });

  it("accepts an empty filter and ignores the value of is_true / is_false", () => {
    expect(parseSegmentFilter({ v: 1, all: [] })).toEqual(EMPTY_FILTER);
    expect(parseSegmentFilter({ v: 1, all: [{ field: "opted_out", op: "is_false", value: "ignored" }] })).not.toBeNull();
  });

  it("every declared field validates with each of its operators", () => {
    const sample = (field: string, op: string) => {
      const spec = fieldSpec(field)!;
      if (op === "is_true" || op === "is_false") return {};
      if (op === "in") return { value: spec.value === "number" ? [1, 2] : ["a", "b"] };
      if (spec.value === "number" || op === "within_days") return { value: 3 };
      return { value: "x" };
    };
    for (const field of SEGMENT_FIELDS) {
      for (const op of FIELD_SPECS[field].ops) {
        const result = segmentFilterSchema.safeParse({ v: 1, all: [{ field, op, ...sample(field, op) }] });
        expect(result.success, `${field} ${op}`).toBe(true);
      }
    }
  });

  it("custom keys are letters, digits and underscores only", () => {
    expect(customFieldKey("custom.city")).toBe("city");
    expect(customFieldKey("custom.course_2")).toBe("course_2");
    expect(customFieldKey("custom.")).toBeNull();
    expect(customFieldKey("custom.a.b")).toBeNull();
    expect(customFieldKey("city")).toBeNull();
  });
});

describe("compileSegmentWhere", () => {
  it("returns {} for an empty filter and AND/OR for all/any", () => {
    expect(compileSegmentWhere(EMPTY_FILTER, NOW)).toEqual({});
    const where = compileSegmentWhere(
      filter(
        [{ field: "tag", op: "eq", value: "hot" }],
        [
          { field: "language", op: "eq", value: "uz" },
          { field: "language", op: "eq", value: "ru" },
        ]
      ),
      NOW
    );
    expect(where).toEqual({
      AND: [{ tags: { some: { tag: { slug: "hot" } } } }, { OR: [{ language: "uz" }, { language: "ru" }] }],
    });
  });

  it("tag / not_tag go through the CrmContactTag relation by slug", () => {
    expect(compileOne({ field: "tag", op: "in", value: ["hot", "vip"] })).toEqual({
      tags: { some: { tag: { slug: { in: ["hot", "vip"] } } } },
    });
    expect(compileOne({ field: "not_tag", op: "eq", value: "qayta" })).toEqual({ tags: { none: { tag: { slug: "qayta" } } } });
    expect(compileOne({ field: "not_tag", op: "in", value: ["a", "b"] })).toEqual({ tags: { none: { tag: { slug: { in: ["a", "b"] } } } } });
  });

  it("score supports eq / neq / gte / lte", () => {
    expect(compileOne({ field: "score", op: "gte", value: 70 })).toEqual({ score: { gte: 70 } });
    expect(compileOne({ field: "score", op: "lte", value: 30 })).toEqual({ score: { lte: 30 } });
    expect(compileOne({ field: "score", op: "eq", value: 50 })).toEqual({ score: 50 });
    expect(compileOne({ field: "score", op: "neq", value: 0 })).toEqual({ score: { not: 0 } });
  });

  it("temperature / status / language / source are scalar columns", () => {
    expect(compileOne({ field: "temperature", op: "eq", value: "HOT" })).toEqual({ temperature: "HOT" });
    expect(compileOne({ field: "temperature", op: "neq", value: "LOST" })).toEqual({ temperature: { not: "LOST" } });
    expect(compileOne({ field: "temperature", op: "in", value: ["HOT", "WARM"] })).toEqual({ temperature: { in: ["HOT", "WARM"] } });
    expect(compileOne({ field: "status", op: "eq", value: "ACTIVE" })).toEqual({ status: "ACTIVE" });
    expect(compileOne({ field: "status", op: "in", value: ["NEW", "ACTIVE"] })).toEqual({ status: { in: ["NEW", "ACTIVE"] } });
    expect(compileOne({ field: "language", op: "neq", value: "en" })).toEqual({ language: { not: "en" } });
    expect(compileOne({ field: "source", op: "eq", value: "COMMENT" })).toEqual({ source: "COMMENT" });
  });

  it("account maps to instagramAccountId", () => {
    expect(compileOne({ field: "account", op: "eq", value: "acc1" })).toEqual({ instagramAccountId: "acc1" });
    expect(compileOne({ field: "account", op: "in", value: ["a", "b"] })).toEqual({ instagramAccountId: { in: ["a", "b"] } });
    expect(compileOne({ field: "account", op: "neq", value: "a" })).toEqual({ instagramAccountId: { not: "a" } });
  });

  it("stage and pipeline go through deals", () => {
    expect(compileOne({ field: "stage", op: "eq", value: "st1" })).toEqual({ deals: { some: { stageId: "st1" } } });
    expect(compileOne({ field: "stage", op: "in", value: ["st1", "st2"] })).toEqual({ deals: { some: { stageId: { in: ["st1", "st2"] } } } });
    expect(compileOne({ field: "stage", op: "neq", value: "st1" })).toEqual({ deals: { none: { stageId: "st1" } } });
    expect(compileOne({ field: "pipeline", op: "eq", value: "p1" })).toEqual({ deals: { some: { stage: { pipelineId: "p1" } } } });
    expect(compileOne({ field: "pipeline", op: "in", value: ["p1", "p2"] })).toEqual({
      deals: { some: { stage: { pipelineId: { in: ["p1", "p2"] } } } },
    });
  });

  it("assigned / unassigned and a specific operator", () => {
    expect(compileOne({ field: "assigned", op: "is_true" })).toEqual({ assignedMemberId: { not: null } });
    expect(compileOne({ field: "assigned", op: "is_false" })).toEqual({ assignedMemberId: null });
    expect(compileOne({ field: "assigned", op: "eq", value: "m1" })).toEqual({ assignedMemberId: "m1" });
    expect(compileOne({ field: "assigned", op: "neq", value: "m1" })).toEqual({ assignedMemberId: { not: "m1" } });
    expect(compileOne({ field: "assigned", op: "in", value: ["m1", "m2"] })).toEqual({ assignedMemberId: { in: ["m1", "m2"] } });
  });

  it("phone / email presence and opt-out are null checks", () => {
    expect(compileOne({ field: "phone_present", op: "is_true" })).toEqual({ phoneE164: { not: null } });
    expect(compileOne({ field: "phone_present", op: "is_false" })).toEqual({ phoneE164: null });
    expect(compileOne({ field: "email_present", op: "is_true" })).toEqual({ email: { not: null } });
    expect(compileOne({ field: "email_present", op: "is_false" })).toEqual({ email: null });
    expect(compileOne({ field: "opted_out", op: "is_true" })).toEqual({ optedOutAt: { not: null } });
    expect(compileOne({ field: "opted_out", op: "is_false" })).toEqual({ optedOutAt: null });
  });

  it("last_interaction counts days back from now", () => {
    expect(compileOne({ field: "last_interaction", op: "within_days", value: 7 })).toEqual({
      lastInteractionAt: { gte: new Date(NOW.getTime() - 7 * DAY) },
    });
    expect(compileOne({ field: "last_interaction", op: "lte", value: 3 })).toEqual({
      lastInteractionAt: { gte: new Date(NOW.getTime() - 3 * DAY) },
    });
    expect(compileOne({ field: "last_interaction", op: "gte", value: 30 })).toEqual({
      lastInteractionAt: { lte: new Date(NOW.getTime() - 30 * DAY) },
    });
  });

  it("window_open is lastInboundAt newer than now − (24h − 5 min)", () => {
    expect(WINDOW_OPEN_MS).toBe(24 * 3600_000 - 5 * 60_000);
    const edge = new Date(NOW.getTime() - WINDOW_OPEN_MS);
    expect(edge.toISOString()).toBe("2026-10-15T12:05:00.000Z");
    expect(compileOne({ field: "window_open", op: "is_true" })).toEqual({ lastInboundAt: { gt: edge } });
    expect(compileOne({ field: "window_open", op: "is_false" })).toEqual({
      OR: [{ lastInboundAt: null }, { lastInboundAt: { lte: edge } }],
    });
  });

  it("custom.<key> becomes a JSON path filter", () => {
    expect(compileOne({ field: "custom.city", op: "eq", value: "Toshkent" })).toEqual({
      customFields: { path: ["city"], equals: "Toshkent" },
    });
    expect(compileOne({ field: "custom.city", op: "neq", value: "Toshkent" })).toEqual({
      customFields: { path: ["city"], not: "Toshkent" },
    });
    expect(compileOne({ field: "custom.course", op: "contains", value: "IELTS" })).toEqual({
      customFields: { path: ["course"], string_contains: "IELTS" },
    });
    expect(compileOne({ field: "custom.budget", op: "gte", value: 100 })).toEqual({ customFields: { path: ["budget"], gte: 100 } });
    expect(compileOne({ field: "custom.budget", op: "lte", value: 500 })).toEqual({ customFields: { path: ["budget"], lte: 500 } });
    expect(compileOne({ field: "custom.city", op: "in", value: ["Toshkent", "Samarqand"] })).toEqual({
      OR: [
        { customFields: { path: ["city"], equals: "Toshkent" } },
        { customFields: { path: ["city"], equals: "Samarqand" } },
      ],
    });
    expect(compileOne({ field: "custom.paid", op: "is_true" })).toEqual({ customFields: { path: ["paid"], equals: true } });
    expect(compileOne({ field: "custom.paid", op: "is_false" })).toEqual({ customFields: { path: ["paid"], equals: false } });
  });

  it("is JSON-serialisable (no functions, Dates survive as ISO)", () => {
    const where = compileSegmentWhere(filter([{ field: "window_open", op: "is_true" }]), NOW);
    expect(JSON.parse(JSON.stringify(where))).toEqual({ AND: [{ lastInboundAt: { gt: "2026-10-15T12:05:00.000Z" } }] });
  });
});

describe("describeFilter", () => {
  it("renders the documented example in Uzbek", () => {
    const text = describeFilter(
      filter([
        { field: "tag", op: "eq", value: "hot" },
        { field: "phone_present", op: "is_true" },
        { field: "custom.city", op: "eq", value: "Toshkent" },
        { field: "custom.course", op: "contains", value: "IELTS" },
      ]),
      { tagNames: { hot: "HOT" } }
    );
    expect(text).toBe('Teg: HOT va Telefon bor va city = Toshkent va course ichida "IELTS"');
  });

  it("uses labels and names, and groups `any` with yoki", () => {
    const text = describeFilter(
      filter(
        [
          { field: "temperature", op: "in", value: ["HOT", "WARM"] },
          { field: "score", op: "gte", value: 70 },
          { field: "stage", op: "eq", value: "st1" },
          { field: "assigned", op: "is_false" },
          { field: "last_interaction", op: "within_days", value: 7 },
          { field: "window_open", op: "is_true" },
          { field: "opted_out", op: "is_false" },
        ],
        [
          { field: "language", op: "eq", value: "uz" },
          { field: "account", op: "eq", value: "acc1" },
        ]
      ),
      { stageNames: { st1: "Yangi lead" }, accountNames: { acc1: "@socialauto" } }
    );
    expect(text).toBe(
      "Harorat: Hot yoki Iliq va Ball ≥ 70 va Bosqich: Yangi lead va Operator biriktirilmagan va Oxirgi aloqa: 7 kun ichida va 24 soatlik oyna ochiq va Obunadan chiqmagan va (Til: uz yoki Akkaunt: @socialauto)"
    );
  });

  it("covers negations, silence and the remaining fields", () => {
    expect(describeFilter(filter([{ field: "not_tag", op: "eq", value: "vip" }]))).toBe("Tegsiz: vip");
    expect(describeFilter(filter([{ field: "temperature", op: "neq", value: "LOST" }]))).toBe("Harorat emas: Yo'qotilgan");
    expect(describeFilter(filter([{ field: "status", op: "eq", value: "NEW" }]))).toBe("Holat: Yangi");
    expect(describeFilter(filter([{ field: "source", op: "eq", value: "COMMENT" }]))).toBe("Manba: Izoh");
    expect(describeFilter(filter([{ field: "pipeline", op: "eq", value: "p1" }], undefined), { pipelineNames: { p1: "Asosiy" } })).toBe("Voronka: Asosiy");
    expect(describeFilter(filter([{ field: "assigned", op: "eq", value: "m1" }]), { memberNames: { m1: "Dilnoza" } })).toBe("Operator: Dilnoza");
    expect(describeFilter(filter([{ field: "assigned", op: "is_true" }]))).toBe("Operator biriktirilgan");
    expect(describeFilter(filter([{ field: "phone_present", op: "is_false" }]))).toBe("Telefon yo'q");
    expect(describeFilter(filter([{ field: "email_present", op: "is_true" }]))).toBe("Email bor");
    expect(describeFilter(filter([{ field: "last_interaction", op: "gte", value: 30 }]))).toBe("Oxirgi aloqa: 30 kundan beri yo'q");
    expect(describeFilter(filter([{ field: "window_open", op: "is_false" }]))).toBe("24 soatlik oyna yopiq");
    expect(describeFilter(filter([{ field: "opted_out", op: "is_true" }]))).toBe("Obunadan chiqqan");
    expect(describeFilter(filter([{ field: "custom.paid", op: "is_true" }]))).toBe("paid: ha");
    expect(describeFilter(filter([{ field: "custom.city", op: "in", value: ["Toshkent", "Buxoro"] }]))).toBe("city: Toshkent yoki Buxoro");
    expect(describeFilter(filter([], [{ field: "language", op: "eq", value: "ru" }]))).toBe("Til: ru");
    expect(describeFilter(EMPTY_FILTER)).toBe("Barcha kontaktlar");
  });
});
