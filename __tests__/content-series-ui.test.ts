/**
 * ETAP 13 Faza 2 — composer logic of story series and recurrence (pure).
 */
import { describe, expect, it } from "vitest";
import { composerBlocked, emptyDraft, mediaRule, storySeriesLabel } from "@/components/content/shared";
import { emptyRecur, recurBody, recurPreview } from "@/components/content/recurrence-fields";

const limits = { captionChars: 2200, hashtags: 30, mentions: 20, firstCommentChars: 2200, altTextChars: 1000, carouselMax: 10, maxCollaborators: 3 };
const item = (id: string) => ({ mediaId: id, kind: "IMAGE", status: "READY" });

describe("story series in the composer (FR-C9)", () => {
  it("a story takes up to 10 media; other single types stay at 1", () => {
    expect(mediaRule("STORY").max).toBe(10);
    expect(mediaRule("REEL").max).toBe(1);
    const story = { ...emptyDraft("acc1", "STORY"), media: ["a", "b", "c"].map(item) };
    expect(composerBlocked(story, limits)).toBeNull();
    expect(composerBlocked({ ...story, media: Array.from({ length: 11 }, (_, i) => item(`x${i}`)) }, limits)).toMatch(/10/);
  });

  it("the preview text names the count, the gap and the times", () => {
    expect(storySeriesLabel(3, null, "Asia/Tashkent")).toBe("3 ta story, 1 daqiqa oraliq bilan");
    expect(storySeriesLabel(3, new Date("2026-10-24T14:00:00Z"), "Asia/Tashkent")).toBe("3 ta story, 1 daqiqa oraliq bilan · 19:00, 19:01, 19:02");
  });
});

describe("recurrence fields (FR-S8)", () => {
  it("is off by default and counts copies live when on", () => {
    const off = emptyRecur("2026-10-24");
    expect(off.on).toBe(false);
    expect(off.until).toBe("2026-11-23");
    expect(recurPreview(off, "2026-10-24", "19:00", "Asia/Tashkent")).toEqual({ count: 0, error: null });
    const weekly = { ...off, on: true, weekdays: [0, 4] };
    expect(recurPreview(weekly, "2026-10-24", "19:00", "Asia/Tashkent").count).toBe(9);
    expect(recurPreview({ ...weekly, weekdays: [] }, "2026-10-24", "19:00", "Asia/Tashkent").error).toMatch(/Hafta kun/);
  });

  it("the body drops weekdays outside the weekly rule", () => {
    expect(recurBody({ on: true, frequency: "daily", interval: 1, weekdays: [1], until: "2026-11-01" }, "2026-10-24", "19:00")).toEqual({ frequency: "daily", interval: 1, weekdays: undefined, startDate: "2026-10-24", time: "19:00", until: "2026-11-01" });
  });
});
