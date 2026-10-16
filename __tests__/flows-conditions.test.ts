/**
 * ETAP 6 — flow condition DSL: schema, every operator, keyword / intent via
 * the campaign normaliser, branch evaluation and the Uzbek description.
 */

import { describe, expect, it } from "vitest";
import {
  compilePredicate,
  describeCondition,
  ELSE_HANDLE,
  evaluateBranches,
  evaluateFilter,
  FIELD_SPECS,
  fieldSpec,
  FLOW_CONDITION_FIELDS,
  type FlowCondition,
  type FlowFilter,
  flowFilterSchema,
  parseFlowFilter,
} from "../lib/flows/conditions";
import type { FlowContext } from "../lib/flows/variables";

function filter(all: FlowCondition[], any?: FlowCondition[]): FlowFilter {
  return { v: 1, all, ...(any ? { any } : {}) };
}

const ctx: FlowContext = {
  contact: { name: "Aziz", phone: "+998901234567", language: "uz" },
  vars: { city: "Toshkent", need: "Mahsulot A", age: "25" },
  trigger: { text: "Нархи канча?", source: "ADS" },
  tags: ["hot", "ielts"],
  score: 72,
  temperature: "HOT",
  audience: "NEW",
  window: { open: true },
  time: { hour: 14, weekday: 3 },
  run: { sends: 2 },
};

describe("flowFilterSchema", () => {
  it("accepts a typical qualification filter", () => {
    expect(
      flowFilterSchema.safeParse({
        v: 1,
        all: [
          { field: "vars.city", op: "contains", value: "toshkent" },
          { field: "score", op: "gte", value: 50 },
          { field: "contact.phone", op: "is_set" },
          { field: "trigger.text", op: "keyword", value: ["narx", "narxi"] },
          { field: "trigger.text", op: "intent", value: "PRICE" },
        ],
        any: [
          { field: "tags", op: "contains", value: "hot" },
          { field: "temperature", op: "in", value: ["HOT", "WARM"] },
        ],
      }).success
    ).toBe(true);
  });

  it("rejects unknown fields, wrong operators and wrong value kinds", () => {
    expect(parseFlowFilter({ v: 1, all: [{ field: "nope", op: "eq", value: "x" }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "tags", op: "gte", value: 3 }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "score", op: "gte", value: "70" }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "score", op: "gte" }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "temperature", op: "in", value: "HOT" }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "temperature", op: "eq", value: ["HOT"] }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "score", op: "in", value: ["a"] }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "trigger.text", op: "intent", value: "NOPE" }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "trigger.text", op: "keyword", value: "" }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "window.open", op: "eq", value: "yes" }] })).toBeNull();
    expect(parseFlowFilter({ v: 1, all: [{ field: "vars.Bad Key", op: "eq", value: 1 }] })).toBeNull();
    expect(parseFlowFilter({ v: 2, all: [] })).toBeNull();
  });

  it("every field has a spec; vars.* gets the open spec", () => {
    for (const field of FLOW_CONDITION_FIELDS) expect(FIELD_SPECS[field].ops.length).toBeGreaterThan(0);
    expect(fieldSpec("vars.city")?.value).toBe("any");
    expect(fieldSpec("vars.")).toBeNull();
  });
});

describe("operators", () => {
  const holds = (cond: FlowCondition, c: FlowContext = ctx) => evaluateFilter(filter([cond]), c);

  it("eq / neq (loose, script-insensitive)", () => {
    expect(holds({ field: "vars.city", op: "eq", value: "toshkent" })).toBe(true);
    expect(holds({ field: "vars.city", op: "eq", value: "Тошкент" })).toBe(true);
    expect(holds({ field: "vars.age", op: "eq", value: 25 })).toBe(true);
    expect(holds({ field: "score", op: "eq", value: 72 })).toBe(true);
    expect(holds({ field: "vars.missing", op: "eq", value: "x" })).toBe(false);
    expect(holds({ field: "vars.city", op: "neq", value: "Samarqand" })).toBe(true);
    expect(holds({ field: "vars.missing", op: "neq", value: "x" })).toBe(true);
    expect(holds({ field: "window.open", op: "eq", value: true })).toBe(true);
    expect(holds({ field: "window.open", op: "eq", value: false })).toBe(false);
    expect(holds({ field: "audience", op: "eq", value: "NEW" })).toBe(true);
  });

  it("in", () => {
    expect(holds({ field: "temperature", op: "in", value: ["WARM", "HOT"] })).toBe(true);
    expect(holds({ field: "temperature", op: "in", value: ["COLD"] })).toBe(false);
    expect(holds({ field: "tags", op: "in", value: ["ielts", "sat"] })).toBe(true);
    expect(holds({ field: "time.weekday", op: "in", value: [6, 7] })).toBe(false);
  });

  it("gte / lte", () => {
    expect(holds({ field: "score", op: "gte", value: 70 })).toBe(true);
    expect(holds({ field: "score", op: "lte", value: 70 })).toBe(false);
    expect(holds({ field: "time.hour", op: "gte", value: 9 })).toBe(true);
    expect(holds({ field: "time.hour", op: "lte", value: 18 })).toBe(true);
    expect(holds({ field: "vars.age", op: "gte", value: 18 })).toBe(true);
    expect(holds({ field: "score", op: "gte", value: 1 }, {})).toBe(false);
  });

  it("contains (text substring, list membership)", () => {
    expect(holds({ field: "vars.city", op: "contains", value: "toshkent" })).toBe(true);
    expect(holds({ field: "vars.city", op: "contains", value: "ТОШКЕНТ" })).toBe(true);
    expect(holds({ field: "tags", op: "contains", value: "hot" })).toBe(true);
    expect(holds({ field: "tags", op: "contains", value: "ho" })).toBe(false);
    expect(holds({ field: "contact.name", op: "contains", value: "zi" })).toBe(true);
  });

  it("is_set / not_set", () => {
    expect(holds({ field: "contact.phone", op: "is_set" })).toBe(true);
    expect(holds({ field: "contact.email", op: "is_set" })).toBe(false);
    expect(holds({ field: "contact.email", op: "not_set" })).toBe(true);
    expect(holds({ field: "tags", op: "not_set" }, { tags: [] })).toBe(true);
    expect(holds({ field: "vars.city", op: "not_set" }, { vars: { city: "  " } })).toBe(true);
  });

  it("keyword goes through the campaign normaliser (whole words, Cyrillic → Latin)", () => {
    // "Нархи канча?" → "narxi kancha": the whole word "narxi" hits, the bare "narx" does not (exactly like a CONTAINS campaign).
    expect(holds({ field: "trigger.text", op: "keyword", value: ["narx", "narxi"] })).toBe(true);
    expect(holds({ field: "trigger.text", op: "keyword", value: "narxi" })).toBe(true);
    expect(holds({ field: "trigger.text", op: "keyword", value: "narx" })).toBe(false);
    expect(holds({ field: "trigger.text", op: "keyword", value: "qancha" }, { trigger: { text: "Salom, NARX QANCHA?" } })).toBe(true);
    expect(holds({ field: "trigger.text", op: "keyword", value: "narx" }, { trigger: { text: "Narx!" } })).toBe(true);
    expect(holds({ field: "trigger.text", op: "keyword", value: "narx" }, {})).toBe(false);
  });

  it("intent uses BUILT_IN_INTENTS variants", () => {
    expect(holds({ field: "trigger.text", op: "intent", value: "PRICE" })).toBe(true);
    expect(holds({ field: "trigger.text", op: "intent", value: ["ADDRESS", "DELIVERY"] })).toBe(false);
    expect(holds({ field: "last_message.text", op: "intent", value: "ADDRESS" }, { last_message: { text: "Manzilingiz qayerda?" } })).toBe(true);
  });

  it("all + any semantics", () => {
    const pred = compilePredicate(filter([{ field: "score", op: "gte", value: 50 }], [{ field: "tags", op: "contains", value: "sat" }, { field: "temperature", op: "eq", value: "HOT" }]));
    expect(pred(ctx)).toBe(true);
    expect(pred({ ...ctx, temperature: "COLD" })).toBe(false);
    expect(pred({ ...ctx, score: 10 })).toBe(false);
    expect(compilePredicate({ v: 1, all: [] })(ctx)).toBe(true);
  });
});

describe("evaluateBranches", () => {
  const node = {
    branches: [
      { id: "tosh", when: filter([{ field: "vars.city", op: "contains", value: "toshkent" }]) },
      { id: "hot", when: filter([{ field: "temperature", op: "eq", value: "HOT" }]) },
    ],
  };

  it("first match wins, else otherwise", () => {
    expect(evaluateBranches(node, ctx)).toBe("tosh");
    expect(evaluateBranches(node, { ...ctx, vars: { city: "Buxoro" } })).toBe("hot");
    expect(evaluateBranches(node, { vars: { city: "Buxoro" }, temperature: "COLD" })).toBe(ELSE_HANDLE);
    expect(evaluateBranches({ branches: [] }, ctx)).toBe("else");
  });
});

describe("describeCondition (uz)", () => {
  it("renders one sentence", () => {
    expect(
      describeCondition(
        filter(
          [
            { field: "score", op: "gte", value: 70 },
            { field: "tags", op: "contains", value: "hot" },
            { field: "contact.phone", op: "is_set" },
            { field: "vars.city", op: "eq", value: "Toshkent" },
            { field: "trigger.text", op: "intent", value: "PRICE" },
          ],
          [
            { field: "contact.language", op: "eq", value: "uz" },
            { field: "contact.language", op: "in", value: ["ru", "en"] },
          ]
        )
      )
    ).toBe('Ball ≥ 70 va Teglar ichida "hot" va Telefon bor va {{vars.city}} = Toshkent va Komment / xabar matnida niyat: Narx va (Til = uz yoki Til: ru yoki en)');
    expect(describeCondition({ v: 1, all: [] })).toBe("Har doim");
    expect(describeCondition(filter([{ field: "window.open", op: "eq", value: false }]))).toBe("24 soatlik oyna yopiq");
    expect(describeCondition(filter([{ field: "trigger.text", op: "keyword", value: ["narx", "narxi"] }]))).toBe("Komment / xabar matnida kalit so'z: narx / narxi");
  });
});
