/**
 * ETAP 13 — "Instagram uchun tayyorlash" (FR-M2, FR-M3, FR-M6): read the
 * uploaded object, verify its bytes agree with the declared type, make the
 * Instagram-ready copy (sharp for images, ffmpeg for video only when the
 * file breaks a Reels rule) and a 640 px JPEG thumbnail, then record the
 * facts on the MediaAsset row.
 *
 * ffmpeg / ffprobe are system binaries (FFMPEG_PATH / FFPROBE_PATH,
 * default on PATH; the Docker image installs them) called through an
 * injectable `exec`, so tests never spawn anything. One transcode at a time
 * (the video worker has concurrency 1) and a 10-minute ceiling. A video is
 * streamed to a temp file and back (StorageDriver.downloadToFile / putFile),
 * never held in memory whole: twenty 500 MB Reels dropped at once must not
 * take the worker down.
 */

import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "@/lib/db/client";
import { MEDIA } from "./config";
import { getStorage, type StorageDriver } from "./storage";

export type ExecFn = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

export interface Probe {
  width?: number;
  height?: number;
  durationMs?: number;
  codec?: string;
  fps?: number;
  audioCodec?: string;
  audioSampleRate?: number;
  /** Overall bitrate, bits per second. */
  bitrate?: number;
  faststart?: boolean;
}

export interface ProcessDeps {
  storage?: StorageDriver;
  exec?: ExecFn;
  tmpDir?: string;
}

const FFMPEG_TIMEOUT_MS = 10 * 60_000;
const THUMB_WIDTH = 640;
const MAX_INPUT_PIXELS = 50e6;

export const defaultExec: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? FFMPEG_TIMEOUT_MS, maxBuffer: 16 * 1024 ** 2, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr).slice(-2000) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

const ffmpegBin = () => process.env.FFMPEG_PATH?.trim() || "ffmpeg";
const ffprobeBin = () => process.env.FFPROBE_PATH?.trim() || "ffprobe";

// ── Magic bytes ──────────────────────────────────────────────────────────────

const HEIC_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif"];

/** The real type of the first bytes, or null when nothing we accept. */
export function detectMagic(head: Buffer): string | null {
  if (head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.subarray(0, 4).toString("binary") === "RIFF" && head.subarray(8, 12).toString("binary") === "WEBP") return "image/webp";
  if (head.subarray(4, 8).toString("binary") === "ftyp") {
    const brand = head.subarray(8, 12).toString("binary").toLowerCase();
    if (HEIC_BRANDS.includes(brand)) return "image/heic";
    if (brand.startsWith("qt")) return "video/quicktime";
    return "video/mp4";
  }
  return null;
}

function kindOfMagic(magic: string | null): "IMAGE" | "VIDEO" | null {
  if (!magic) return null;
  return magic.startsWith("image/") ? "IMAGE" : "VIDEO";
}

// ── Images ───────────────────────────────────────────────────────────────────

/** JPEG, sRGB, width ≤ 1440, under 8 MB (quality steps down until it fits). */
export async function prepareImage(buf: Buffer): Promise<{ out: Buffer; width: number; height: number }> {
  const base = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" }).rotate().toColorspace("srgb");
  const meta = await base.metadata();
  const resized = (meta.width ?? 0) > MEDIA.imageMaxWidth ? base.resize({ width: MEDIA.imageMaxWidth, withoutEnlargement: true }) : base;
  for (const quality of [90, 80, 70, 60]) {
    const out = await resized.clone().flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
    if (out.length <= MEDIA.imagePreparedMaxBytes || quality === 60) {
      const m = await sharp(out).metadata();
      return { out, width: m.width ?? 0, height: m.height ?? 0 };
    }
  }
  throw new Error("unreachable");
}

async function thumbFromImage(buf: Buffer): Promise<Buffer> {
  return sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "none" })
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}

// ── Video ────────────────────────────────────────────────────────────────────

function parseRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [n, d] = value.split("/").map(Number);
  if (!Number.isFinite(n)) return undefined;
  if (d === undefined) return n;
  return d ? n / d : undefined;
}

export async function probeVideo(file: string, exec: ExecFn = defaultExec): Promise<Probe> {
  const { stdout } = await exec(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { timeoutMs: 60_000 });
  const json = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: { duration?: string; bit_rate?: string; tags?: Record<string, unknown> };
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  const audio = json.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(json.format?.duration ?? video?.duration);
  const bitrate = Number(json.format?.bit_rate ?? video?.bit_rate);
  return {
    width: typeof video?.width === "number" ? video.width : undefined,
    height: typeof video?.height === "number" ? video.height : undefined,
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : undefined,
    codec: typeof video?.codec_name === "string" ? video.codec_name : undefined,
    fps: parseRate(video?.r_frame_rate) ?? parseRate(video?.avg_frame_rate),
    audioCodec: typeof audio?.codec_name === "string" ? audio.codec_name : undefined,
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : undefined,
    bitrate: Number.isFinite(bitrate) ? bitrate : undefined,
    // ffprobe does not expose atom order; the upload path marks faststart
    // via the "moov before mdat" check in hasFaststart below.
    faststart: undefined,
  };
}

/** Is the moov atom before mdat? (Instagram wants it that way.) Cheap scan of the first 64 KB. */
export function hasFaststart(head: Buffer): boolean {
  const moov = head.indexOf("moov", 0, "binary");
  const mdat = head.indexOf("mdat", 0, "binary");
  if (moov === -1) return false;
  if (mdat === -1) return true;
  return moov < mdat;
}

const VIDEO_CODECS_OK = ["h264", "hevc"];

export function needsTranscode(p: Probe): boolean {
  if (!p.codec || !VIDEO_CODECS_OK.includes(p.codec.toLowerCase())) return true;
  if (p.fps !== undefined && (p.fps < 23 || p.fps > 60)) return true;
  if (p.bitrate !== undefined && p.bitrate > 25_000_000) return true;
  if (p.audioCodec && p.audioCodec.toLowerCase() !== "aac") return true;
  if (p.audioSampleRate !== undefined && p.audioSampleRate > 48_000) return true;
  if (p.faststart === false) return true;
  return false;
}

/** H.264 + AAC 128k 48 kHz, ≤ 25 Mbps, fps clamped to 23–60, moov first. */
export function ffmpegArgs(input: string, output: string, p: Probe): string[] {
  const fps = p.fps === undefined ? undefined : Math.min(60, Math.max(23, Math.round(p.fps)));
  return [
    "-y",
    "-i", input,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-maxrate", "25M",
    "-bufsize", "50M",
    "-pix_fmt", "yuv420p",
    ...(fps ? ["-r", String(fps)] : []),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-movflags", "+faststart",
    output,
  ];
}

async function grabFrame(exec: ExecFn, input: string, output: string, atMs: number): Promise<void> {
  await exec(ffmpegBin(), ["-y", "-ss", (atMs / 1000).toFixed(3), "-i", input, "-frames:v", "1", "-q:v", "3", output], { timeoutMs: 60_000 });
}

// ── Orchestration ────────────────────────────────────────────────────────────

const MAGIC_MISMATCH = "Fayl turi mos emas — fayl e'lon qilingan formatda emas";

/** The first `bytes` of a file on disk (magic number, moov-before-mdat scan). */
async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function variantKey(originalKey: string, variant: "prepared" | "thumb", ext: string): string {
  const dot = originalKey.lastIndexOf(".");
  return `${originalKey.slice(0, dot)}.${variant}.${ext}`;
}

/** UPLOADING / PROCESSING → READY (facts, prepared copy, thumbnail) or FAILED (reason). */
export async function processMedia(mediaId: string, deps: ProcessDeps = {}): Promise<void> {
  const storage = deps.storage ?? getStorage();
  const exec = deps.exec ?? defaultExec;
  const asset = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset || asset.status === "DELETED" || asset.status === "READY") return;

  const fail = async (message: string) => {
    await prisma.mediaAsset.updateMany({ where: { id: mediaId, status: { not: "DELETED" } }, data: { status: "FAILED", error: message.slice(0, 500) } });
  };

  let tmp: string | null = null;
  try {
    let preparedKey: string;
    let thumbKey: string;
    let preparedBytes: number;
    let addedBytes = 0;
    const facts: { width?: number; height?: number; durationMs?: number; codec?: string; fps?: number } = {};

    if (asset.kind === "IMAGE") {
      const original = await storage.getObject(asset.originalKey);
      if (kindOfMagic(detectMagic(original.subarray(0, 16))) !== "IMAGE") {
        await fail(MAGIC_MISMATCH);
        return;
      }
      const prepared = await prepareImage(original);
      const thumb = await thumbFromImage(prepared.out);
      preparedKey = variantKey(asset.originalKey, "prepared", "jpg");
      thumbKey = variantKey(asset.originalKey, "thumb", "jpg");
      await storage.putObject(preparedKey, prepared.out, "image/jpeg");
      await storage.putObject(thumbKey, thumb, "image/jpeg");
      addedBytes = prepared.out.length + thumb.length;
      preparedBytes = prepared.out.length;
      facts.width = prepared.width;
      facts.height = prepared.height;
    } else {
      tmp = await mkdtemp(path.join(deps.tmpDir ?? os.tmpdir(), "socialauto-media-"));
      const inputExt = asset.originalKey.slice(asset.originalKey.lastIndexOf(".") + 1) || "mp4";
      const input = path.join(tmp, `in.${inputExt}`);
      if (storage.downloadToFile) await storage.downloadToFile(asset.originalKey, input);
      else await writeFile(input, await storage.getObject(asset.originalKey));
      const head = await readHead(input, 64 * 1024);
      if (kindOfMagic(detectMagic(head.subarray(0, 16))) !== "VIDEO") {
        await fail(MAGIC_MISMATCH);
        return;
      }
      const probe = await probeVideo(input, exec);
      probe.faststart = hasFaststart(head);
      facts.width = probe.width;
      facts.height = probe.height;
      facts.durationMs = probe.durationMs;
      facts.codec = probe.codec;
      facts.fps = probe.fps;

      if (needsTranscode(probe)) {
        const output = path.join(tmp, "out.mp4");
        await exec(ffmpegBin(), ffmpegArgs(input, output, probe), { timeoutMs: FFMPEG_TIMEOUT_MS });
        preparedKey = variantKey(asset.originalKey, "prepared", "mp4");
        if (storage.putFile) await storage.putFile(preparedKey, output, "video/mp4");
        else await storage.putObject(preparedKey, await readFile(output), "video/mp4");
        preparedBytes = (await stat(output)).size;
        addedBytes += preparedBytes;
        facts.codec = "h264";
        if (probe.fps !== undefined) facts.fps = Math.min(60, Math.max(23, Math.round(probe.fps)));
      } else {
        preparedKey = asset.originalKey;
        preparedBytes = (await stat(input)).size;
      }

      const framePath = path.join(tmp, "thumb.jpg");
      const at = Math.min(500, Math.max(0, (probe.durationMs ?? 1000) / 2));
      await grabFrame(exec, input, framePath, at);
      const thumb = await thumbFromImage(await readFile(framePath));
      thumbKey = variantKey(asset.originalKey, "thumb", "jpg");
      await storage.putObject(thumbKey, thumb, "image/jpeg");
      addedBytes += thumb.length;
    }

    // The user may have cancelled (deleted) the upload while it was processed:
    // never resurrect the row, and drop the copies just written.
    const done = await prisma.mediaAsset.updateMany({
      where: { id: mediaId, status: { not: "DELETED" } },
      data: { status: "READY", error: null, preparedKey, thumbKey, preparedBytes, ...facts },
    });
    if (done.count === 0) {
      for (const key of [preparedKey, thumbKey]) {
        if (key !== asset.originalKey) await storage.deleteObject(key).catch(() => undefined);
      }
      return;
    }
    if (addedBytes > 0) {
      await prisma.workspace.update({ where: { id: asset.workspaceId }, data: { mediaStorageBytes: { increment: BigInt(addedBytes) } } });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string })?.stderr;
    await fail(/ENOENT/.test(message) && /ff(mpeg|probe)/.test(message) ? "Serverda ffmpeg o'rnatilmagan" : stderr ? `${message} — ${stderr}` : message);
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
