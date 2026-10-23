/**
 * ETAP 13 — caption counters (code points, hashtags, mentions) and the
 * Instagram username normaliser (spec §6 rules 1 and 5).
 */
import { describe, expect, it } from "vitest";
import { countCaption, normalizeUsernames, USERNAME_RE } from "@/lib/content/text";

describe("countCaption", () => {
  it("counts code points, hashtags and mentions", () => {
    // "salom #a #b @x 👋" = 16 code points (the emoji is one), 2 hashtags, 1 mention
    expect(countCaption("salom #a #b @x 👋")).toEqual({ chars: 16, hashtags: 2, mentions: 1 });
  });

  it("counts Cyrillic and Uzbek apostrophes as single characters", () => {
    expect(countCaption("oʻzbek").chars).toBe(6);
    expect(countCaption("Привет #салом").hashtags).toBe(1);
  });

  it("ignores # and @ glued inside words", () => {
    expect(countCaption("email@x.uz item#3")).toEqual({ chars: 17, hashtags: 0, mentions: 0 });
  });

  it("empty text is all zeros", () => {
    expect(countCaption("")).toEqual({ chars: 0, hashtags: 0, mentions: 0 });
  });
});

describe("normalizeUsernames", () => {
  it("strips @, trims, drops invalid and merges duplicates case-insensitively", () => {
    expect(normalizeUsernames(["@Foo", "foo", "Bar!", "  baz "])).toEqual(["Foo", "baz"]);
  });

  it("username regex", () => {
    expect(USERNAME_RE.test("a.b_c1")).toBe(true);
    expect(USERNAME_RE.test("x".repeat(31))).toBe(false);
    expect(USERNAME_RE.test("")).toBe(false);
  });
});
