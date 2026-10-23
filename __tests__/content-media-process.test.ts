/**
 * ETAP 13 — media processing (FR-M2, FR-M3): sharp makes the Instagram-ready
 * JPEG and the thumbnail, ffprobe facts decide whether ffmpeg runs, magic
 * bytes must agree with the declared MIME type. ffmpeg/ffprobe are injected.
 */
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import {
  detectMagic,
  ffmpegArgs,
  needsTranscode,
  prepareImage,
  probeVideo,
  processMedia,
  type ExecFn,
  type Probe,
} from "@/lib/content/media-process";

const WS = "ws1";

class FakeStorage {
  objects = new Map<string, Buffer>();
  async getObject(key: string) {
    const b = this.objects.get(key);
    if (!b) throw new Error(`missing ${key}`);
    return b;
  }
  async putObject(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async headObject(key: string) {
    const b = this.objects.get(key);
    return b ? { size: b.length } : null;
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
  async presignGet() {
    return "x";
  }
  async presignPut() {
    return { url: "x", headers: {} };
  }
}

const FFPROBE_JSON = JSON.stringify({
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, r_frame_rate: "30/1", bit_rate: "8000000" },
    { codec_type: "audio", codec_name: "aac", sample_rate: "48000" },
  ],
  format: { duration: "45.000000", bit_rate: "8200000", tags: {} },
});

beforeEach(() => {
  resetDb();
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", mediaStorageBytes: 0 });
});

describe("prepareImage", () => {
  it("returns a JPEG no wider than 1440", async () => {
    const png = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#f00" } }).png().toBuffer();
    const r = await prepareImage(png);
    expect(r.width).toBe(1440);
    expect(r.height).toBe(480);
    expect(r.out.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

describe("needsTranscode / ffmpegArgs", () => {
  const ok: Probe = { codec: "h264", fps: 30, bitrate: 8e6, audioCodec: "aac", faststart: true, width: 1080, height: 1920, durationMs: 45000 };
  it("keeps an already compliant file", () => {
    expect(needsTranscode(ok)).toBe(false);
  });
  it("transcodes odd fps, foreign codecs, high bitrate, non-aac audio and no faststart", () => {
    expect(needsTranscode({ ...ok, fps: 120 })).toBe(true);
    expect(needsTranscode({ ...ok, codec: "vp9" })).toBe(true);
    expect(needsTranscode({ ...ok, bitrate: 80e6 })).toBe(true);
    expect(needsTranscode({ ...ok, audioCodec: "opus" })).toBe(true);
    expect(needsTranscode({ ...ok, faststart: false })).toBe(true);
  });
  it("ffmpeg arguments pin faststart and 128k aac", () => {
    const args = ffmpegArgs("in.mov", "out.mp4", { ...ok, fps: 120 });
    expect(args.join(" ")).toContain("-movflags +faststart");
    expect(args.join(" ")).toContain("-b:a 128k");
    expect(args.join(" ")).toContain("-ar 48000");
    expect(args).toContain("libx264");
    expect(args[args.length - 1]).toBe("out.mp4");
  });
});

describe("probeVideo", () => {
  it("parses ffprobe JSON into facts", async () => {
    const exec: ExecFn = vi.fn(async () => ({ stdout: FFPROBE_JSON, stderr: "" }));
    const p = await probeVideo("file.mp4", exec);
    expect(p).toMatchObject({ width: 1080, height: 1920, durationMs: 45000, codec: "h264", fps: 30, audioCodec: "aac", bitrate: 8200000 });
    expect(vi.mocked(exec).mock.calls[0][0]).toMatch(/ffprobe/);
  });
});

describe("detectMagic", () => {
  it("recognises jpeg, png, webp, heic and mp4", () => {
    expect(detectMagic(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(detectMagic(Buffer.from("\x89PNG\r\n\x1a\n00000000", "binary"))).toBe("image/png");
    expect(detectMagic(Buffer.from("RIFF0000WEBPVP8 ", "binary"))).toBe("image/webp");
    expect(detectMagic(Buffer.from("\0\0\0\x18ftypheic\0\0\0\0", "binary"))).toBe("image/heic");
    expect(detectMagic(Buffer.from("\0\0\0\x18ftypisom\0\0\0\0", "binary"))).toBe("video/mp4");
    expect(detectMagic(Buffer.from("hello world!!!!!"))).toBeNull();
  });
});

describe("processMedia", () => {
  it("fails the asset when the bytes do not match the declared type", async () => {
    const storage = new FakeStorage();
    storage.objects.set(`ws/${WS}/2026/10/a.jpg`, Buffer.from("not really a jpeg at all, just text"));
    db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: `ws/${WS}/2026/10/a.jpg`, mimeType: "image/jpeg", sizeBytes: 34, status: "PROCESSING" });
    await processMedia("m1", { storage });
    const a = db.rows("mediaAsset")[0];
    expect(a.status).toBe("FAILED");
    expect(String(a.error)).toMatch(/turi mos emas/);
  });

  it("prepares an image: READY with prepared + thumb keys, metadata and storage accounted", async () => {
    const storage = new FakeStorage();
    const png = await sharp({ create: { width: 2000, height: 2500, channels: 3, background: "#0f0" } }).png().toBuffer();
    storage.objects.set(`ws/${WS}/2026/10/a.png`, png);
    db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: `ws/${WS}/2026/10/a.png`, mimeType: "image/png", sizeBytes: png.length, status: "PROCESSING" });
    await processMedia("m1", { storage });
    const a = db.rows("mediaAsset")[0];
    expect(a.status).toBe("READY");
    expect(a.preparedKey).toBe(`ws/${WS}/2026/10/a.prepared.jpg`);
    expect(a.thumbKey).toBe(`ws/${WS}/2026/10/a.thumb.jpg`);
    expect(a.width).toBe(1440);
    expect(a.height).toBe(1800);
    const prepared = storage.objects.get(`ws/${WS}/2026/10/a.prepared.jpg`)!;
    const thumb = storage.objects.get(`ws/${WS}/2026/10/a.thumb.jpg`)!;
    expect(a.preparedBytes).toBe(prepared.length); // I2: Instagram's 8 MB applies to this copy, not the upload
    expect((await sharp(thumb).metadata()).width).toBe(640);
    expect(Number(db.rows("workspace")[0].mediaStorageBytes)).toBe(prepared.length + thumb.length);
  });

  it("processes a compliant video without transcoding: prepared = original, thumb from ffmpeg", async () => {
    const storage = new FakeStorage();
    // moov before mdat = faststart already, so no transcode is needed
    const fake = Buffer.from("\0\0\0\x18ftypisom\0\0\0\0moov\0\0\0\0mdat", "binary");
    storage.objects.set(`ws/${WS}/2026/10/v.mp4`, fake);
    db.seed("mediaAsset", { id: "m2", workspaceId: WS, kind: "VIDEO", originalKey: `ws/${WS}/2026/10/v.mp4`, mimeType: "video/mp4", sizeBytes: fake.length, status: "PROCESSING" });
    const frame = await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#00f" } }).jpeg().toBuffer();
    const exec: ExecFn = vi.fn(async (cmd: string, args: string[]) => {
      if (/ffprobe/.test(cmd)) return { stdout: FFPROBE_JSON, stderr: "" };
      // ffmpeg frame grab: write the frame to the output path (last arg)
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[args.length - 1], frame);
      return { stdout: "", stderr: "" };
    });
    await processMedia("m2", { storage, exec });
    const a = db.rows("mediaAsset")[0];
    expect(a.status).toBe("READY");
    expect(a.preparedKey).toBe(`ws/${WS}/2026/10/v.mp4`);
    expect(a.thumbKey).toBe(`ws/${WS}/2026/10/v.thumb.jpg`);
    expect(a).toMatchObject({ width: 1080, height: 1920, durationMs: 45000, codec: "h264", fps: 30 });
    const ffmpegCalls = vi.mocked(exec).mock.calls.filter((c) => /ffmpeg/.test(c[0]));
    expect(ffmpegCalls).toHaveLength(1); // only the thumbnail grab
  });

  it("transcodes a non-compliant video and uploads the prepared copy", async () => {
    const storage = new FakeStorage();
    const fake = Buffer.from("\0\0\0\x18ftypqt  \0\0\0\0mdat", "binary");
    storage.objects.set(`ws/${WS}/2026/10/v.mov`, fake);
    db.seed("mediaAsset", { id: "m3", workspaceId: WS, kind: "VIDEO", originalKey: `ws/${WS}/2026/10/v.mov`, mimeType: "video/quicktime", sizeBytes: fake.length, status: "PROCESSING" });
    const probe = JSON.parse(FFPROBE_JSON);
    probe.streams[0].codec_name = "prores";
    probe.streams[0].bit_rate = "80000000";
    const frame = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#000" } }).jpeg().toBuffer();
    const exec: ExecFn = vi.fn(async (cmd: string, args: string[]) => {
      const { writeFile } = await import("node:fs/promises");
      if (/ffprobe/.test(cmd)) return { stdout: JSON.stringify(probe), stderr: "" };
      const out = args[args.length - 1];
      await writeFile(out, out.endsWith(".jpg") ? frame : Buffer.from("TRANSCODED"));
      return { stdout: "", stderr: "" };
    });
    await processMedia("m3", { storage, exec });
    const a = db.rows("mediaAsset")[0];
    expect(a.status).toBe("READY");
    expect(a.preparedKey).toBe(`ws/${WS}/2026/10/v.prepared.mp4`);
    expect(storage.objects.get(`ws/${WS}/2026/10/v.prepared.mp4`)!.toString()).toBe("TRANSCODED");
  });
});
