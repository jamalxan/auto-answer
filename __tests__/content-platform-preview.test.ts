import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Preview from "../components/content/preview";
import { emptyDraft, type MediaItemDraft, type PostDraft } from "../components/content/shared";
import { channelBlocker, formatFor, threadsText, youtubeTitle } from "../lib/content/platform-preview";

const video: MediaItemDraft = { mediaId: "m1", kind: "VIDEO", status: "READY", thumbUrl: "https://cdn.test/t.jpg", previewUrl: "https://cdn.test/v.mp4", width: 1080, height: 1920, durationMs: 9000, userTags: [] };
const image: MediaItemDraft = { ...video, mediaId: "m2", kind: "IMAGE", previewUrl: "https://cdn.test/full.jpg" };

function draft(type: PostDraft["type"], media: MediaItemDraft[], caption = "Salom dunyo\nikkinchi qator"): PostDraft {
  return { ...emptyDraft("a1", type), media, caption };
}
const html = (d: PostDraft, platform: Parameters<typeof Preview>[0]["platform"]) => renderToStaticMarkup(createElement(Preview, { draft: d, username: "brand", platform }));

describe("platform rules", () => {
  it("a Reel is a Reel on Facebook, a Short on YouTube and a video elsewhere", () => {
    expect(formatFor("REEL", "facebook")).toBe("reel");
    expect(formatFor("REEL", "youtube")).toBe("short");
    expect(formatFor("REEL", "threads")).toBe("video");
    expect(formatFor("FEED_VIDEO", "youtube")).toBe("video");
    expect(formatFor("FEED_IMAGE", "threads", false)).toBe("text");
  });

  it("blocks stories everywhere and images on YouTube", () => {
    expect(channelBlocker("facebook", "STORY", true)).toMatch(/Story/);
    expect(channelBlocker("youtube", "FEED_IMAGE", true)).toMatch(/video/i);
    expect(channelBlocker("youtube", "REEL", true)).toBeNull();
    expect(channelBlocker("threads", "CAROUSEL", true)).toBeNull();
    expect(channelBlocker("facebook", "REEL", true)).toBeNull();
  });

  it("youtube title is the first line, #Shorts for a Short, max 100", () => {
    expect(youtubeTitle("Salom\nkeyingi", "video")).toBe("Salom");
    expect(youtubeTitle("Salom", "short")).toBe("Salom #Shorts");
    expect(youtubeTitle("Salom #shorts", "short")).toBe("Salom #shorts");
    expect(youtubeTitle("", "video")).toBe("Video");
    expect(youtubeTitle("x".repeat(300), "video")).toHaveLength(100);
  });

  it("threads cuts at 500 characters", () => {
    expect(threadsText("a".repeat(600))).toEqual({ text: "a".repeat(500), cut: true });
    expect(threadsText("  kalta ")).toEqual({ text: "kalta", cut: false });
  });
});

describe("live preview shows the real media", () => {
  it("plays a video from its file with the thumbnail as poster (Reel, feed video, Story)", () => {
    for (const type of ["REEL", "FEED_VIDEO", "STORY"] as const) {
      const out = html(draft(type, [video]), "instagram");
      expect(out, type).toContain('src="https://cdn.test/v.mp4"');
      expect(out, type).toContain('poster="https://cdn.test/t.jpg"');
    }
  });

  it("falls back to the poster image when a video has no playable file", () => {
    const out = html(draft("REEL", [{ ...video, previewUrl: null }]), "instagram");
    expect(out).not.toContain("<video");
    expect(out).toContain('src="https://cdn.test/t.jpg"');
  });

  it("shows a photo and says so while the file is still processing", () => {
    expect(html(draft("FEED_IMAGE", [image]), "instagram")).toContain('src="https://cdn.test/full.jpg"');
    expect(html(draft("REEL", [{ ...video, status: "PROCESSING" }]), "instagram")).toContain("tayyorlanmoqda");
  });

  it("uses each network's own layout", () => {
    expect(html(draft("REEL", [video]), "instagram")).toContain("Kuzatish");
    expect(html(draft("REEL", [video]), "facebook")).toContain("Reels sifatida");
    expect(html(draft("REEL", [video]), "youtube")).toContain("Shorts sifatida");
    expect(html(draft("REEL", [video]), "youtube")).toContain("Salom dunyo #Shorts");
    expect(html(draft("FEED_VIDEO", [video]), "youtube")).toContain("aspect-video");
    expect(html(draft("FEED_VIDEO", [video]), "threads")).toContain("v.mp4");
    expect(html(draft("STORY", [video]), "instagram")).toContain("Xabar yuborish");
    expect(html(draft("CAROUSEL", [image, image]), "instagram")).toContain("1/2");
  });
});
