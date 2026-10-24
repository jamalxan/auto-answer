/**
 * ETAP 13 — the field matrix (spec §6) and the media rules every post is
 * checked against before it is saved and again before it is published
 * (AC-11). Pure: no DB.
 */
import { describe, expect, it } from "vitest";
import { campaignKeywordWarnings, FIELD_MATRIX, scheduleIssues, validatePost, type MediaFacts } from "@/lib/content/validate";
import type { PostInput } from "@/lib/content/schema";

const OPTS = { carouselMax: 10, maxCollaborators: 3 };

function image(id: string, width = 1080, height = 1350, extra: Partial<MediaFacts> = {}): MediaFacts {
  return { id, kind: "IMAGE", status: "READY", width, height, durationMs: null, sizeBytes: 500_000, ...extra };
}
function video(id: string, durationMs: number, extra: Partial<MediaFacts> = {}): MediaFacts {
  return { id, kind: "VIDEO", status: "READY", width: 1080, height: 1920, durationMs, sizeBytes: 20_000_000, ...extra };
}
function post(over: Partial<PostInput>): PostInput {
  return { instagramAccountId: "acc1", type: "FEED_IMAGE", media: [{ mediaId: "m1" }], ...over } as PostInput;
}
const fields = (issues: { field: string }[]) => issues.map((i) => i.field);

describe("caption rules", () => {
  it("rejects 2300 characters, 31 hashtags and 21 mentions", () => {
    expect(fields(validatePost(post({ caption: "x".repeat(2300) }), [image("m1")], OPTS))).toContain("caption");
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    const r = validatePost(post({ caption: tags }), [image("m1")], OPTS);
    expect(r.find((i) => i.field === "caption")?.message).toMatch(/30/);
    const mentions = Array.from({ length: 21 }, (_, i) => `@u${i}`).join(" ");
    expect(fields(validatePost(post({ caption: mentions }), [image("m1")], OPTS))).toContain("caption");
  });

  it("story has no caption, collaborators or first comment", () => {
    const r = validatePost(
      post({ type: "STORY", caption: "hi", collaborators: ["a"], firstComment: "x" }),
      [image("m1", 1080, 1920)],
      OPTS
    );
    expect(fields(r)).toEqual(expect.arrayContaining(["caption", "collaborators", "firstComment"]));
  });

  it("accepts a clean feed image", () => {
    expect(validatePost(post({ caption: "Salom #a @b" }), [image("m1")], OPTS)).toEqual([]);
  });
});

describe("media rules", () => {
  it("feed image with a video asset must be a reel", () => {
    const r = validatePost(post({}), [video("m1", 10_000)], OPTS);
    expect(r.find((i) => i.field === "type")?.message).toMatch(/Reels/);
  });

  it("3:1 image is outside 4:5…1.91:1", () => {
    const r = validatePost(post({}), [image("m1", 3000, 1000)], OPTS);
    expect(r.find((i) => i.field === "media[0]")?.message).toMatch(/1\.91/);
  });

  it("feed image user tags need coordinates, reels do not", () => {
    expect(fields(validatePost(post({ media: [{ mediaId: "m1", userTags: [{ username: "a" }] }] }), [image("m1")], OPTS))).toContain("media[0].userTags");
    expect(validatePost(post({ type: "REEL", media: [{ mediaId: "m1", userTags: [{ username: "a" }] }] }), [video("m1", 10_000)], OPTS)).toEqual([]);
  });

  it("carousel needs 2..max items", () => {
    expect(fields(validatePost(post({ type: "CAROUSEL" }), [image("m1")], OPTS))).toContain("media");
    const many = Array.from({ length: 11 }, (_, i) => ({ mediaId: `m${i}` }));
    const facts = many.map((m) => image(m.mediaId));
    expect(fields(validatePost(post({ type: "CAROUSEL", media: many }), facts, OPTS))).toContain("media");
  });

  it("carousel video over 60 s, story video over 60 s, reel under 3 s or over 300 MB", () => {
    expect(fields(validatePost(post({ type: "CAROUSEL", media: [{ mediaId: "m1" }, { mediaId: "m2" }] }), [image("m1"), video("m2", 61_000)], OPTS))).toContain("media[1]");
    const story = validatePost(post({ type: "STORY" }), [video("m1", 62_000)], OPTS);
    expect(story.find((i) => i.field === "media[0]")?.message).toMatch(/60/);
    expect(fields(validatePost(post({ type: "REEL" }), [video("m1", 2_000)], OPTS))).toContain("media[0]");
    expect(fields(validatePost(post({ type: "REEL" }), [video("m1", 10_000, { sizeBytes: 301 * 1024 ** 2 })], OPTS))).toContain("media[0]");
  });

  it("collaborators limited and validated", () => {
    expect(fields(validatePost(post({ collaborators: ["a", "b", "c", "d"] }), [image("m1")], OPTS))).toContain("collaborators");
    expect(fields(validatePost(post({ collaborators: ["bad name!"] }), [image("m1")], OPTS))).toContain("collaborators");
  });

  it("media must be READY and present", () => {
    const r = validatePost(post({}), [image("m1", 1080, 1350, { status: "PROCESSING" })], OPTS);
    expect(r.find((i) => i.field === "media[0]")?.message).toMatch(/tayyor emas/);
    expect(fields(validatePost(post({}), [], OPTS))).toContain("media[0]");
  });
});

describe("schedule window", () => {
  const now = new Date("2026-10-24T10:00:00Z");
  it("needs at least 5 minutes lead and at most 365 days", () => {
    expect(scheduleIssues(new Date(now.getTime() + 4 * 60_000), now)).toHaveLength(1);
    expect(scheduleIssues(new Date(now.getTime() + 6 * 60_000), now)).toEqual([]);
    expect(scheduleIssues(new Date(now.getTime() + 366 * 86_400_000), now)).toHaveLength(1);
  });
});

describe("campaignKeywordWarnings (FR-L5)", () => {
  it("warns only when a caption type misses every keyword", () => {
    expect(campaignKeywordWarnings("REEL", "Yangi video", ["narx"])).toEqual([expect.objectContaining({ field: "caption" })]);
    expect(campaignKeywordWarnings("REEL", "Narx deb yozing", ["narx"])).toEqual([]);
    expect(campaignKeywordWarnings("STORY", "", ["narx"])).toEqual([]);
    expect(campaignKeywordWarnings("REEL", "x", [])).toEqual([]);
  });
});

describe("FIELD_MATRIX", () => {
  it("mirrors spec §6", () => {
    expect(FIELD_MATRIX.STORY.caption).toBe(false);
    expect(FIELD_MATRIX.STORY.userTagCoords).toBe("optional");
    expect(FIELD_MATRIX.FEED_IMAGE.userTagCoords).toBe("required");
    expect(FIELD_MATRIX.REEL.cover).toBe(true);
    expect(FIELD_MATRIX.TRIAL_REEL.shareToFeed).toBe(false);
    expect(FIELD_MATRIX.CAROUSEL.altText).toBe(true);
    expect(FIELD_MATRIX.FEED_VIDEO.altText).toBe(false);
  });
});
