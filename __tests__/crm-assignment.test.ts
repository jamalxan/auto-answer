/**
 * ETAP 5.3 — operator assignment: round robin, team, specialist, rule
 * selection. Pure functions only.
 */

import { describe, expect, it } from "vitest";
import {
  assignmentPool,
  chooseAssignee,
  matchSpecialistKeyword,
  pickRule,
  roundRobin,
  rulesFor,
  sortRules,
  type AssignmentCandidate,
  type AssignmentRule,
} from "../lib/crm/assignment-logic";
import type { CrmAssignmentRuleRow } from "../lib/crm/types";

const candidates: AssignmentCandidate[] = [
  { memberId: "a", active: true },
  { memberId: "b", active: true },
  { memberId: "c", active: true },
];

function rule(overrides: Partial<AssignmentRule> = {}): AssignmentRule {
  return { strategy: "ROUND_ROBIN", memberIds: [], productKeywords: [], ...overrides };
}

const context = { tags: [] as string[] };

describe("roundRobin / chooseAssignee ROUND_ROBIN", () => {
  it("walks the candidates from the cursor and wraps around", () => {
    expect(chooseAssignee({ rule: rule(), candidates, cursor: 0, context })).toEqual({ memberId: "a", nextCursor: 1 });
    expect(chooseAssignee({ rule: rule(), candidates, cursor: 1, context })).toEqual({ memberId: "b", nextCursor: 2 });
    expect(chooseAssignee({ rule: rule(), candidates, cursor: 2, context })).toEqual({ memberId: "c", nextCursor: 0 });
    expect(chooseAssignee({ rule: rule(), candidates, cursor: 3, context })).toEqual({ memberId: "a", nextCursor: 1 });
    expect(chooseAssignee({ rule: rule(), candidates, cursor: 7, context })).toEqual({ memberId: "b", nextCursor: 2 });
  });

  it("tolerates a cursor left over from a longer list, or a negative one", () => {
    expect(roundRobin(candidates, 300)).toEqual({ memberId: "a", nextCursor: 1 });
    expect(roundRobin(candidates, -1)).toEqual({ memberId: "c", nextCursor: 0 });
  });

  it("skips inactive members and advances past them", () => {
    const withInactive: AssignmentCandidate[] = [
      { memberId: "a", active: true },
      { memberId: "b", active: false },
      { memberId: "c", active: true },
    ];
    expect(roundRobin(withInactive, 1)).toEqual({ memberId: "c", nextCursor: 0 });
    // Wraps around an inactive tail.
    const inactiveTail: AssignmentCandidate[] = [
      { memberId: "a", active: true },
      { memberId: "b", active: false },
      { memberId: "c", active: false },
    ];
    expect(roundRobin(inactiveTail, 1)).toEqual({ memberId: "a", nextCursor: 1 });
  });

  it("returns null when nobody is active or the pool is empty", () => {
    expect(roundRobin([], 0)).toBeNull();
    expect(roundRobin([{ memberId: "a", active: false }], 0)).toBeNull();
    expect(chooseAssignee({ rule: rule(), candidates: [], cursor: 0, context })).toBeNull();
  });

  it("distributes evenly over a full cycle", () => {
    const seen: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 6; i++) {
      const pick = chooseAssignee({ rule: rule(), candidates, cursor, context })!;
      seen.push(pick.memberId);
      cursor = pick.nextCursor;
    }
    expect(seen).toEqual(["a", "b", "c", "a", "b", "c"]);
  });
});

describe("TEAM", () => {
  it("rotates only inside the rule's members, in rule order", () => {
    const team = rule({ strategy: "TEAM", memberIds: ["c", "a"] });
    expect(assignmentPool(team, candidates).map((c) => c.memberId)).toEqual(["c", "a"]);
    expect(chooseAssignee({ rule: team, candidates, cursor: 0, context })).toEqual({ memberId: "c", nextCursor: 1 });
    expect(chooseAssignee({ rule: team, candidates, cursor: 1, context })).toEqual({ memberId: "a", nextCursor: 0 });
  });

  it("ignores member ids that are no longer workspace operators", () => {
    const team = rule({ strategy: "TEAM", memberIds: ["gone", "b"] });
    expect(chooseAssignee({ rule: team, candidates, cursor: 0, context })).toEqual({ memberId: "b", nextCursor: 0 });
    expect(chooseAssignee({ rule: rule({ strategy: "TEAM", memberIds: ["gone"] }), candidates, cursor: 0, context })).toBeNull();
  });
});

describe("SPECIALIST", () => {
  const specialist = rule({ strategy: "SPECIALIST", memberIds: ["b"], productKeywords: ["IELTS", "ingliz tili"] });

  it("matches product keywords with normalizeForMatch against product, lead product and tags", () => {
    expect(matchSpecialistKeyword(specialist.productKeywords, { product: "ielts kursi", tags: [] })).toBe("IELTS");
    expect(matchSpecialistKeyword(specialist.productKeywords, { leadProduct: "Инглиз тили", tags: [] })).toBe("ingliz tili");
    expect(matchSpecialistKeyword(specialist.productKeywords, { tags: ["hot", "IELTS"] })).toBe("IELTS");
    expect(matchSpecialistKeyword(specialist.productKeywords, { product: "Матем", tags: ["vip"] })).toBeNull();
    // Whole words only, and nothing to match against.
    expect(matchSpecialistKeyword(["ielts"], { product: "ieltsx", tags: [] })).toBeNull();
    expect(matchSpecialistKeyword(["ielts"], { tags: [] })).toBeNull();
    expect(matchSpecialistKeyword(["ielts"], { product: null, leadProduct: undefined, tags: [""] })).toBeNull();
  });

  it("assigns the specialist on a match and reports the keyword", () => {
    expect(chooseAssignee({ rule: specialist, candidates, cursor: 0, context: { product: "IELTS 7.0", tags: [] } })).toEqual({
      memberId: "b",
      nextCursor: 0,
      matchedKeyword: "IELTS",
    });
  });

  it("returns null without a match so the caller falls through to the next rule", () => {
    expect(chooseAssignee({ rule: specialist, candidates, cursor: 0, context: { product: "SAT", tags: ["hot"] } })).toBeNull();
    expect(chooseAssignee({ rule: rule({ strategy: "SPECIALIST" }), candidates, cursor: 0, context: { product: "IELTS", tags: [] } })).toBeNull();
  });

  it("returns null when the matching specialists are all inactive", () => {
    const inactive: AssignmentCandidate[] = [{ memberId: "b", active: false }];
    expect(chooseAssignee({ rule: specialist, candidates: inactive, cursor: 0, context: { product: "IELTS", tags: [] } })).toBeNull();
  });
});

describe("pickRule", () => {
  function row(overrides: Partial<CrmAssignmentRuleRow> & { id: string }): CrmAssignmentRuleRow {
    return {
      workspaceId: "w",
      name: overrides.id,
      active: true,
      trigger: "ON_HOT",
      strategy: "ROUND_ROBIN",
      stageId: null,
      memberIds: [],
      productKeywords: [],
      priority: 0,
      cursor: 0,
      createdAt: new Date("2026-10-01T00:00:00Z"),
      ...overrides,
    };
  }

  it("orders by priority (higher first) then createdAt (older first)", () => {
    const rules = [
      row({ id: "old-low", priority: 0, createdAt: new Date("2026-09-01T00:00:00Z") }),
      row({ id: "new-high", priority: 10, createdAt: new Date("2026-10-10T00:00:00Z") }),
      row({ id: "old-high", priority: 10, createdAt: new Date("2026-09-15T00:00:00Z") }),
      row({ id: "new-low", priority: 0, createdAt: new Date("2026-10-12T00:00:00Z") }),
    ];
    expect(sortRules(rules).map((r) => r.id)).toEqual(["old-high", "new-high", "old-low", "new-low"]);
    expect(pickRule(rules, "ON_HOT")?.id).toBe("old-high");
    // Original array untouched.
    expect(rules[0].id).toBe("old-low");
  });

  it("filters by trigger and skips inactive rules", () => {
    const rules = [
      row({ id: "lead", trigger: "ON_LEAD", priority: 100 }),
      row({ id: "hot-off", trigger: "ON_HOT", priority: 50, active: false }),
      row({ id: "hot", trigger: "ON_HOT" }),
    ];
    expect(pickRule(rules, "ON_HOT")?.id).toBe("hot");
    expect(pickRule(rules, "ON_LEAD")?.id).toBe("lead");
    expect(pickRule(rules, "ON_HANDOFF")).toBeNull();
    expect(rulesFor(rules, "ON_HOT").map((r) => r.id)).toEqual(["hot"]);
  });

  it("ON_STAGE rules apply only to their stage", () => {
    const rules = [row({ id: "s1", trigger: "ON_STAGE", stageId: "st1" }), row({ id: "s2", trigger: "ON_STAGE", stageId: "st2", priority: 5 })];
    expect(pickRule(rules, "ON_STAGE", "st1")?.id).toBe("s1");
    expect(pickRule(rules, "ON_STAGE", "st2")?.id).toBe("s2");
    expect(pickRule(rules, "ON_STAGE", "st3")).toBeNull();
    expect(pickRule(rules, "ON_STAGE")).toBeNull();
  });

  it("rulesFor lists the fallbacks in order so SPECIALIST can fall through", () => {
    const rules = [
      row({ id: "rr", strategy: "ROUND_ROBIN", priority: 0 }),
      row({ id: "spec", strategy: "SPECIALIST", priority: 10, productKeywords: ["ielts"] }),
    ];
    const ordered = rulesFor(rules, "ON_HOT");
    expect(ordered.map((r) => r.id)).toEqual(["spec", "rr"]);
    const noMatch = chooseAssignee({ rule: ordered[0], candidates, cursor: 0, context: { product: "SAT", tags: [] } });
    expect(noMatch).toBeNull();
    expect(chooseAssignee({ rule: ordered[1], candidates, cursor: 0, context: { product: "SAT", tags: [] } })?.memberId).toBe("a");
  });
});
