/**
 * Giveaway rules (lib/engagement/giveaway/rules.ts): schema, tagged handles and
 * the pure evaluateEntry matrix.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  RULE_VERIFIABILITY,
  evaluateEntry,
  extractTaggedHandles,
  giveawayRulesSchema,
  parseRules,
  type EntryFacts,
  type GiveawayRules,
} from "@/lib/engagement/giveaway/rules";

const NOW = new Date("2026-10-20T12:00:00Z");

const rules = (patch: Record<string, unknown> = {}): GiveawayRules => giveawayRulesSchema.parse(patch);
const facts = (patch: Partial<EntryFacts> = {}): EntryFacts => ({
  igUserId: "6001",
  username: "ali",
  commentText: "Men ham ishtirok etaman",
  taggedUsernames: [],
  mentionedAt: null,
  followResult: "NOT_CHECKED",
  ...patch,
});

describe("schema", () => {
  it("fills the defaults", () => {
    expect(DEFAULT_RULES.comment).toEqual({ required: true, mode: "ANY", minLength: 0 });
    expect(DEFAULT_RULES.tagFriends).toEqual({ required: false, min: 1, distinct: true });
    expect(DEFAULT_RULES.follow).toEqual({ required: false, onUnverifiable: "HOLD" });
    expect(DEFAULT_RULES.oneEntryPerPerson).toBe(true);
    expect(DEFAULT_RULES.excludeStaff).toBe(true);
    expect(DEFAULT_RULES.excludeUsernames).toEqual([]);
  });

  it("rejects bad values and falls back to the defaults when parsing stored junk", () => {
    expect(giveawayRulesSchema.safeParse({ tagFriends: { min: 0 } }).success).toBe(false);
    expect(giveawayRulesSchema.safeParse({ comment: { mode: "REGEX" } }).success).toBe(false);
    expect(parseRules({ comment: { mode: "REGEX" } })).toEqual(DEFAULT_RULES);
    expect(parseRules(null)).toEqual(DEFAULT_RULES);
  });

  it("states honestly what can be verified", () => {
    expect(RULE_VERIFIABILITY.comment.verifiable).toBe("yes");
    expect(RULE_VERIFIABILITY.tagFriends.verifiable).toBe("partly");
    expect(RULE_VERIFIABILITY.follow.verifiable).toBe("best-effort");
    for (const key of ["like", "save", "share", "followOther"]) expect(RULE_VERIFIABILITY[key].verifiable).toBe("no");
  });
});

describe("extractTaggedHandles", () => {
  it("finds distinct lower-cased handles", () => {
    expect(extractTaggedHandles("@Ali @vali va @ali yana @sher_01.x")).toEqual(["ali", "vali", "sher_01.x"]);
  });

  it("drops a sentence-ending dot, e-mails and the business itself", () => {
    expect(extractTaggedHandles("do'stim @maria.")).toEqual(["maria"]);
    expect(extractTaggedHandles("yozing info@shop.uz")).toEqual([]);
    expect(extractTaggedHandles("@Shop @ali", "shop")).toEqual(["ali"]);
    expect(extractTaggedHandles("@shop", "@SHOP")).toEqual([]);
  });

  it("can keep duplicates", () => {
    expect(extractTaggedHandles("@a @a @b", null, { keepDuplicates: true })).toEqual(["a", "a", "b"]);
  });
});

describe("evaluateEntry", () => {
  it("any comment qualifies by default; an empty one does not", () => {
    expect(evaluateEntry(rules(), facts(), NOW).status).toBe("ELIGIBLE");
    const empty = evaluateEntry(rules(), facts({ commentText: "  " }), NOW);
    expect(empty.status).toBe("INELIGIBLE");
    expect(empty.checks.comment.passed).toBe(false);
  });

  it("keyword CONTAINS matches whole words, normalised; EXACT needs the whole comment", () => {
    const contains = rules({ comment: { mode: "CONTAINS", keyword: "Giveaway, konkurs" } });
    expect(evaluateEntry(contains, facts({ commentText: "men KONKURS da!" }), NOW).status).toBe("ELIGIBLE");
    expect(evaluateEntry(contains, facts({ commentText: "konkurslar" }), NOW).status).toBe("INELIGIBLE");
    const exact = rules({ comment: { mode: "EXACT", keyword: "men" } });
    expect(evaluateEntry(exact, facts({ commentText: "Men" }), NOW).status).toBe("ELIGIBLE");
    expect(evaluateEntry(exact, facts({ commentText: "men ham" }), NOW).status).toBe("INELIGIBLE");
  });

  it("minLength and a keyword mode without a keyword", () => {
    expect(evaluateEntry(rules({ comment: { minLength: 10 } }), facts({ commentText: "ha" }), NOW).status).toBe("INELIGIBLE");
    expect(evaluateEntry(rules({ comment: { mode: "CONTAINS" } }), facts(), NOW).status).toBe("ELIGIBLE");
    expect(evaluateEntry(rules({ comment: { required: false } }), facts({ commentText: "" }), NOW).status).toBe("ELIGIBLE");
  });

  it("tag friends: distinct handles reach the minimum, the person themselves does not count", () => {
    const r = rules({ tagFriends: { required: true, min: 2 } });
    expect(evaluateEntry(r, facts({ taggedUsernames: ["x", "y"] }), NOW).status).toBe("ELIGIBLE");
    expect(evaluateEntry(r, facts({ taggedUsernames: ["x"] }), NOW).status).toBe("INELIGIBLE");
    expect(evaluateEntry(r, facts({ taggedUsernames: ["x", "ali"] }), NOW).status).toBe("INELIGIBLE");
    const loose = rules({ tagFriends: { required: true, min: 2, distinct: false } });
    expect(evaluateEntry(loose, facts({ commentText: "@x @x", taggedUsernames: ["x"] }), NOW).status).toBe("ELIGIBLE");
  });

  it("mention needs mentionedAt", () => {
    const r = rules({ mention: { required: true } });
    const without = evaluateEntry(r, facts(), NOW);
    expect(without.status).toBe("INELIGIBLE");
    expect(without.reason).toMatch(/Story/);
    expect(evaluateEntry(r, facts({ mentionedAt: NOW }), NOW).status).toBe("ELIGIBLE");
  });

  it("follow: not checked waits, FOLLOWER passes, NOT_FOLLOWER fails", () => {
    const r = rules({ follow: { required: true } });
    expect(evaluateEntry(r, facts(), NOW).status).toBe("PENDING_CHECK");
    expect(evaluateEntry(r, facts({ followResult: "FOLLOWER" }), NOW).status).toBe("ELIGIBLE");
    expect(evaluateEntry(r, facts({ followResult: "NOT_FOLLOWER" }), NOW).status).toBe("INELIGIBLE");
  });

  it("follow UNVERIFIABLE follows the policy: ALLOW / HOLD / EXCLUDE", () => {
    const run = (onUnverifiable: string) =>
      evaluateEntry(rules({ follow: { required: true, onUnverifiable } }), facts({ followResult: "UNVERIFIABLE" }), NOW).status;
    expect(run("ALLOW")).toBe("ELIGIBLE");
    expect(run("HOLD")).toBe("PENDING_CHECK");
    expect(run("EXCLUDE")).toBe("INELIGIBLE");
  });

  it("a failed rule wins over a pending follow check", () => {
    const r = rules({ comment: { mode: "CONTAINS", keyword: "men" }, follow: { required: true } });
    const result = evaluateEntry(r, facts({ commentText: "salom" }), NOW);
    expect(result.status).toBe("INELIGIBLE");
    expect(result.checks.follow.passed).toBeNull();
  });

  it("excludeUsernames (with or without @, any case) and the business's own account", () => {
    const r = rules({ excludeUsernames: ["@Blogger_X"] });
    expect(evaluateEntry(r, facts({ username: "blogger_x" }), NOW).status).toBe("INELIGIBLE");
    expect(evaluateEntry(r, facts({ username: "ali" }), NOW).status).toBe("ELIGIBLE");
    expect(evaluateEntry(rules(), facts({ isOwnAccount: true }), NOW).status).toBe("INELIGIBLE");
    expect(evaluateEntry(rules({ excludeStaff: false }), facts({ isOwnAccount: true }), NOW).status).toBe("ELIGIBLE");
  });

  it("stamps each check with the evaluation time", () => {
    const result = evaluateEntry(rules({ mention: { required: true } }), facts({ mentionedAt: NOW }), NOW);
    expect(result.checks.mention.at).toBe(NOW.toISOString());
    expect(result.reason).toBeNull();
  });
});
