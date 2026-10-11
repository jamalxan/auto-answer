/**
 * Trigger Engine — keyword conditions and campaign selection.
 */

import { describe, expect, it } from "vitest";
import {
  cleanKeywords,
  evaluateCampaign,
  matchText,
  selectCampaign,
  type MatchableCampaign,
} from "../lib/triggers/matching";
import { displayStatus, shortStoryId } from "../lib/triggers/display";

let n = 0;
function campaign(overrides: Partial<MatchableCampaign> = {}): MatchableCampaign {
  n++;
  return {
    id: `c${n}`,
    triggerType: "STORY_REPLY",
    storyScope: "ALL",
    storyIds: [],
    keywords: [],
    matchingMode: "EVERY",
    active: true,
    createdAt: new Date(2026, 0, n),
    ...overrides,
  };
}

describe("matchText", () => {
  it("CONTAINS catches the spec examples for “narx”", () => {
    for (const text of ["narx", "narxi", "narxchi?", "narxi qancha", "NARXI QANCHA?!", "Narxi 🔥 qancha"]) {
      expect(matchText(text, ["narx"], "CONTAINS").matched, text).toBe(true);
    }
    expect(matchText("salom", ["narx"], "CONTAINS").matched).toBe(false);
  });

  it("is case-insensitive in Cyrillic too", () => {
    expect(matchText("Какая ЦЕНА?", ["цена"], "CONTAINS")).toEqual({ matched: true, matchedKeyword: "цена" });
  });

  it("folds Latin diacritics and Uzbek apostrophe variants", () => {
    expect(matchText("PREÇO", ["preco"], "CONTAINS").matched).toBe(true);
    // o‘ / o' / o` all reduce to the same letters once punctuation is stripped
    expect(matchText("To‘lov qanday?", ["to'lov"], "CONTAINS").matched).toBe(true);
  });

  it("EXACT needs the whole reply to be the keyword", () => {
    expect(matchText("Narx!", ["narx"], "EXACT").matched).toBe(true);
    expect(matchText("  narx 🔥 ", ["narx"], "EXACT").matched).toBe(true);
    expect(matchText("narxi", ["narx"], "EXACT").matched).toBe(false);
    expect(matchText("narx qancha", ["narx"], "EXACT").matched).toBe(false);
    expect(matchText("narx qancha", ["narx qancha"], "EXACT").matched).toBe(true);
  });

  it("EVERY matches anything, even an empty reply", () => {
    expect(matchText("", [], "EVERY")).toEqual({ matched: true, matchedKeyword: null });
  });

  it("returns the first keyword that hits", () => {
    expect(matchText("kurs narxi", ["цена", "narx", "kurs"], "CONTAINS").matchedKeyword).toBe("narx");
  });

  it("an empty or emoji-only reply never matches a keyword", () => {
    expect(matchText("🔥🔥", ["narx"], "CONTAINS").matched).toBe(false);
    expect(matchText("", ["narx"], "EXACT").matched).toBe(false);
  });
});

describe("cleanKeywords", () => {
  it("trims, drops blanks and case/punctuation duplicates", () => {
    expect(cleanKeywords([" narx ", "", "NARX", "narx!", "цена", "  "])).toEqual(["narx", "цена"]);
  });
});

describe("evaluateCampaign", () => {
  it("respects active flag, trigger type and story scope", () => {
    const event = { type: "STORY_REPLY" as const, text: "narx", storyId: "s1" };
    expect(evaluateCampaign(campaign({ active: false }), event)).toEqual({ matched: false, reason: "inactive" });
    expect(evaluateCampaign(campaign({ triggerType: "DIRECT_MESSAGE" }), event)).toEqual({
      matched: false,
      reason: "wrong_trigger",
    });
    expect(evaluateCampaign(campaign({ storyScope: "SPECIFIC", storyIds: ["s2"] }), event)).toEqual({
      matched: false,
      reason: "story_scope",
    });
    expect(evaluateCampaign(campaign({ storyScope: "SPECIFIC", storyIds: ["s1"] }), event).matched).toBe(true);
    // A story-scoped campaign never matches a reply with no story id.
    expect(
      evaluateCampaign(campaign({ storyScope: "SPECIFIC", storyIds: ["s1"] }), { ...event, storyId: null }).matched
    ).toBe(false);
  });

  it("a keyword mode with no keywords matches nothing", () => {
    expect(evaluateCampaign(campaign({ matchingMode: "CONTAINS", keywords: [" "] }), { type: "STORY_REPLY", text: "x" })).toEqual({
      matched: false,
      reason: "no_keywords",
    });
  });
});

describe("selectCampaign", () => {
  const event = { type: "STORY_REPLY" as const, text: "Narxi qancha?", storyId: "s1" };

  it("explains why nothing matched", () => {
    expect(selectCampaign([], event).ignoredReason).toMatch(/faol campaign yo'q/);
    expect(selectCampaign([campaign({ matchingMode: "CONTAINS", keywords: ["salom"] })], event).ignoredReason).toMatch(
      /Kalit so'z mos kelmadi/
    );
    expect(selectCampaign([campaign({ storyScope: "SPECIFIC", storyIds: ["other"] })], event).ignoredReason).toMatch(
      /story uchun/
    );
    expect(selectCampaign([campaign({ triggerType: "STORY_MENTION" })], event).considered).toBe(0);
  });

  it("prefers the most specific campaign: specific story > exact > contains > every", () => {
    const every = campaign();
    const contains = campaign({ matchingMode: "CONTAINS", keywords: ["narx"] });
    const specific = campaign({ storyScope: "SPECIFIC", storyIds: ["s1"] });
    expect(selectCampaign([every, contains], event).campaign?.id).toBe(contains.id);
    expect(selectCampaign([every, contains, specific], event).campaign?.id).toBe(specific.id);
    const exact = campaign({ matchingMode: "EXACT", keywords: ["narxi qancha"] });
    expect(selectCampaign([contains, exact], event)).toMatchObject({
      campaign: { id: exact.id },
      matchedKeyword: "narxi qancha",
    });
  });

  it("breaks ties by age, so the pick is stable", () => {
    const older = campaign({ matchingMode: "CONTAINS", keywords: ["narx"] });
    const newer = campaign({ matchingMode: "CONTAINS", keywords: ["qancha"] });
    expect(selectCampaign([newer, older], event).campaign?.id).toBe(older.id);
  });

  it("skips inactive campaigns", () => {
    const off = campaign({ active: false, storyScope: "SPECIFIC", storyIds: ["s1"] });
    const on = campaign();
    expect(selectCampaign([off, on], event).campaign?.id).toBe(on.id);
  });
});

describe("displayStatus", () => {
  it("maps event + action to the log status", () => {
    expect(displayStatus({ processingStatus: "PROCESSED", executions: [{ status: "SENT" }] }).label).toBe("Yuborildi");
    expect(displayStatus({ processingStatus: "IGNORED", executions: [] }).key).toBe("IGNORED");
    expect(displayStatus({ processingStatus: "RETRYING", executions: [{ status: "RETRYING" }] }).label).toBe(
      "Qayta yuboriladi"
    );
    expect(displayStatus({ processingStatus: "FAILED", executions: [{ status: "FAILED" }] }).tone).toBe("error");
    expect(displayStatus({ processingStatus: "PENDING", executions: [] }).key).toBe("PROCESSING");
    expect(displayStatus({ processingStatus: "PROCESSED", executions: [{ status: "SKIPPED" }] }).key).toBe("SKIPPED");
  });

  it("shortens story ids", () => {
    expect(shortStoryId("18000000000000042")).toBe("#000042");
    expect(shortStoryId(null)).toBe("—");
  });
});
