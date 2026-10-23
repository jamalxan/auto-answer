/**
 * ETAP 13 — crop (FR-M4): the ratio presets, the centred rectangle, the
 * cropped image the publisher hands Meta, and user tags moved into the
 * cropped frame. Pure helpers plus sharp on an in-memory image.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { centerCrop, croppedImage, croppedRatio, CROP_PRESETS, tagsInCrop } from "@/lib/content/crop";
import { validatePost, type MediaFacts } from "@/lib/content/validate";
import type { PostInput } from "@/lib/content/schema";

const OPTS = { carouselMax: 10, maxCollaborators: 3 };
const portrait: MediaFacts = { id: "m1", kind: "IMAGE", status: "READY", width: 1080, height: 1440, durationMs: null, sizeBytes: 500_000 };
const post = (over: Partial<PostInput>): PostInput => ({ instagramAccountId: "a", type: "FEED_IMAGE", media: [{ mediaId: "m1" }], ...over }) as PostInput;

describe("crop presets", () => {
  it("offers 1:1, 4:5, 1.91:1 and 9:16", () => {
    expect(CROP_PRESETS.map((p) => p.label)).toEqual(["1:1", "4:5", "1.91:1", "9:16"]);
  });

  it("centres a 4:5 frame on a 3:4 photo (full width, trimmed height)", () => {
    const r = centerCrop(1080, 1440, 0.8);
    expect(r.x).toBe(0);
    expect(r.w).toBe(1);
    expect(r.h).toBeCloseTo(0.9375, 4);
    expect(r.y).toBeCloseTo(0.0313, 3);
    expect(croppedRatio(1080, 1440, r)).toBeCloseTo(0.8, 3);
  });

  it("centres a 1:1 frame on a landscape photo (full height, trimmed width)", () => {
    const r = centerCrop(2000, 1000, 1);
    expect(r).toMatchObject({ y: 0, h: 1 });
    expect(r.w).toBeCloseTo(0.5, 4);
    expect(r.x).toBeCloseTo(0.25, 4);
  });
});

describe("validation with a crop", () => {
  it("a 3:4 photo is refused without a crop and accepted with a 4:5 one", () => {
    expect(validatePost(post({}), [portrait], OPTS).some((i) => i.field === "media[0]")).toBe(true);
    const ok = validatePost(post({ media: [{ mediaId: "m1", cropRect: centerCrop(1080, 1440, 0.8) }] }), [portrait], OPTS);
    expect(ok).toEqual([]);
  });

  it("a crop outside the image is refused", () => {
    const r = validatePost(post({ media: [{ mediaId: "m1", cropRect: { x: 0.5, y: 0, w: 0.8, h: 1 } }] }), [portrait], OPTS);
    expect(r.find((i) => i.field === "media[0]")?.message).toMatch(/Kesish/);
  });
});

describe("tags in the cropped frame", () => {
  it("re-maps coordinates and clamps tags that fall outside", () => {
    const rect = { x: 0, y: 0.25, w: 1, h: 0.5 };
    expect(tagsInCrop([{ username: "a", x: 0.5, y: 0.5 }, { username: "b", x: 0.1, y: 0.1 }, { username: "c" }], rect)).toEqual([
      { username: "a", x: 0.5, y: 0.5 },
      { username: "b", x: 0.1, y: 0 },
      { username: "c" },
    ]);
  });
});

describe("croppedImage", () => {
  it("cuts the prepared JPEG to the rectangle", async () => {
    const src = await sharp({ create: { width: 1080, height: 1440, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    const out = await croppedImage(src, centerCrop(1080, 1440, 0.8));
    const m = await sharp(out).metadata();
    expect(m.format).toBe("jpeg");
    expect(m.width).toBe(1080);
    expect(m.height).toBe(1350);
  });
});
