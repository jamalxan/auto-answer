/**
 * ETAP 13 — the pure helpers behind the Content screens: status colours,
 * calendar bucketing in the workspace zone, the composer's main button,
 * which fields a post type shows (mirrors FIELD_MATRIX).
 */
import { describe, expect, it } from "vitest";
import { composerBlocked, composerButtonLabel, defaultSlot, emptyDraft, fieldVisible, groupPostsByDay, postCardTone, STATUS_LABEL, TYPE_LABEL, typeForMedia } from "@/components/content/shared";

describe("postCardTone", () => {
  it("maps statuses to the design tones", () => {
    expect(postCardTone("PUBLISHED")).toBe("success");
    expect(postCardTone("PUBLISHED_MANUAL")).toBe("success");
    expect(postCardTone("FAILED")).toBe("error");
    expect(postCardTone("NEEDS_MANUAL")).toBe("warning");
    expect(postCardTone("DRAFT")).toBe("muted");
    expect(postCardTone("SCHEDULED")).toBe("scheduled");
  });
  it("has a label for every status and type", () => {
    expect(Object.keys(STATUS_LABEL)).toHaveLength(14);
    expect(Object.keys(TYPE_LABEL)).toHaveLength(6);
  });
});

describe("groupPostsByDay", () => {
  it("buckets by the wall-clock date of the zone", () => {
    const posts = [
      { id: "a", scheduledAt: "2026-10-24T22:30:00.000Z" }, // 25 Oct 03:30 Tashkent
      { id: "b", scheduledAt: "2026-10-24T10:00:00.000Z" }, // 24 Oct
      { id: "c", scheduledAt: null },
    ];
    const grouped = groupPostsByDay(posts, "Asia/Tashkent");
    expect(grouped.get("2026-10-25")?.map((p) => p.id)).toEqual(["a"]);
    expect(grouped.get("2026-10-24")?.map((p) => p.id)).toEqual(["b"]);
    expect(grouped.get("")).toBeUndefined();
  });
});

describe("composerButtonLabel", () => {
  const at = new Date("2026-10-24T14:00:00Z");
  it("names the slot in the zone when scheduling", () => {
    expect(composerButtonLabel({ mode: "schedule", at, tz: "Asia/Tashkent", canSchedule: true })).toBe("Rejalashtirish · 24-okt, 19:00");
  });
  it("sends to review when the role cannot schedule", () => {
    expect(composerButtonLabel({ mode: "schedule", at, tz: "Asia/Tashkent", canSchedule: false })).toBe("Tasdiqqa yuborish");
  });
  it("now / draft", () => {
    expect(composerButtonLabel({ mode: "now", at: null, tz: "Asia/Tashkent", canSchedule: true })).toBe("Hozir chiqarish");
    expect(composerButtonLabel({ mode: "draft", at: null, tz: "Asia/Tashkent", canSchedule: true })).toBe("Draft sifatida saqlash");
  });
});

describe("fieldVisible", () => {
  it("mirrors the field matrix", () => {
    expect(fieldVisible("STORY", "caption")).toBe(false);
    expect(fieldVisible("REEL", "cover")).toBe(true);
    expect(fieldVisible("FEED_IMAGE", "altText")).toBe(true);
    expect(fieldVisible("TRIAL_REEL", "trial")).toBe(true);
    expect(fieldVisible("CAROUSEL", "shareToFeed")).toBe(false);
  });
});

describe("typeForMedia (FR-C2)", () => {
  it("a video dropped into a feed post makes it a video post (Reels), two files make a carousel", () => {
    expect(typeForMedia("FEED_IMAGE", ["VIDEO"])).toBe("FEED_VIDEO");
    expect(typeForMedia("FEED_VIDEO", ["IMAGE"])).toBe("FEED_IMAGE");
    expect(typeForMedia("FEED_IMAGE", ["IMAGE", "IMAGE"])).toBe("CAROUSEL");
    expect(typeForMedia("REEL", ["IMAGE"])).toBe("FEED_IMAGE");
  });
  it("keeps the type when the media fits", () => {
    expect(typeForMedia("FEED_IMAGE", ["IMAGE"])).toBe("FEED_IMAGE");
    expect(typeForMedia("CAROUSEL", ["IMAGE", "VIDEO"])).toBe("CAROUSEL");
    expect(typeForMedia("STORY", ["VIDEO"])).toBe("STORY");
    expect(typeForMedia("FEED_IMAGE", [])).toBe("FEED_IMAGE");
  });
});

describe("composerBlocked (FR-C3)", () => {
  const limits = { captionChars: 2200, hashtags: 30, mentions: 20, firstCommentChars: 2200, altTextChars: 1000, carouselMax: 10, maxCollaborators: 3 };
  const base = { ...emptyDraft("acc1"), media: [{ mediaId: "m1", kind: "IMAGE", status: "READY" }] };
  it("passes a plain draft", () => {
    expect(composerBlocked({ ...base, caption: "Salom #a @b" }, limits)).toBeNull();
  });
  it("blocks on the caption limits", () => {
    expect(composerBlocked({ ...base, caption: "x".repeat(2201) }, limits)).toMatch(/2200/);
    expect(composerBlocked({ ...base, caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") }, limits)).toMatch(/30/);
    expect(composerBlocked({ ...base, caption: Array.from({ length: 21 }, (_, i) => `@u${i}`).join(" ") }, limits)).toMatch(/20/);
  });
  it("blocks when media is missing, not ready, or there are too many collaborators", () => {
    expect(composerBlocked({ ...base, media: [] }, limits)).toMatch(/media/i);
    expect(composerBlocked({ ...base, media: [{ mediaId: "m1", kind: "IMAGE", status: "PROCESSING" }] }, limits)).toMatch(/tayyor/);
    expect(composerBlocked({ ...base, collaborators: ["a", "b", "c", "d"] }, limits)).toMatch(/3/);
  });
  it("a story ignores the caption", () => {
    expect(composerBlocked({ ...base, type: "STORY", caption: "x".repeat(3000) }, limits)).toBeNull();
  });
});

describe("defaultSlot (FR-S1)", () => {
  const now = new Date("2026-10-24T09:03:00Z"); // 14:03 Tashkent
  it("rounds 'now + 30 min' up to 5 minutes in the zone", () => {
    expect(defaultSlot(null, "Asia/Tashkent", now)).toEqual({ date: "2026-10-24", time: "14:35" });
  });
  it("a clicked future day gets 19:00", () => {
    expect(defaultSlot("2026-10-30", "Asia/Tashkent", now)).toEqual({ date: "2026-10-30", time: "19:00" });
  });
  it("a clicked day that is today falls back to the rounded time", () => {
    expect(defaultSlot("2026-10-24", "Asia/Tashkent", now)).toEqual({ date: "2026-10-24", time: "14:35" });
  });
});
