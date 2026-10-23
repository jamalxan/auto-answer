/**
 * Content Scheduler — local filesystem media driver.
 *
 * Dev / self-host fallback for the S3 driver: objects live under
 * MEDIA_LOCAL_DIR (default `.media`) and the "presigned" URLs point at
 * /api/developer/content/media/local/<key> with an HMAC token so the browser
 * can PUT / GET without a session, exactly like it would against a bucket.
 *
 * The token signs `${method}|${key}|${exp}` with NEXTAUTH_SECRET, so a PUT
 * URL cannot be replayed as a GET and vice versa, and every key has to match
 * MEDIA_KEY_RE before it touches the disk (no `..`, no absolute paths).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { getBaseUrl, requireEnv } from "@/lib/env";
import type { StorageDriver } from "./storage";

/** `ws/<wsId>/<yyyy>/<mm>/<id>.<ext>` plus the `.prepared` / `.thumb` variants. */
export class UploadTooLargeError extends Error {
  constructor() {
    super("Upload is larger than declared");
  }
}

export const MEDIA_KEY_RE =
  /^ws\/[a-z0-9]+\/\d{4}\/\d{2}\/[a-z0-9-]+(\.(prepared|thumb|crop-[a-z0-9]+))?\.[a-z0-9]+$/;

export type LocalTokenMethod = "put" | "get";

export const LOCAL_ROUTE_PREFIX = "/api/developer/content/media/local";

export function isValidMediaKey(key: string): boolean {
  return typeof key === "string" && MEDIA_KEY_RE.test(key);
}

function assertKey(key: string): void {
  if (!isValidMediaKey(key)) {
    throw new Error("Media kaliti noto'g'ri");
  }
}

export function getLocalDir(): string {
  const raw = (process.env.MEDIA_LOCAL_DIR ?? "").trim() || ".media";
  return path.resolve(/*turbopackIgnore: true*/ raw);
}

/** Absolute path of a key inside MEDIA_LOCAL_DIR; throws on an invalid key. */
export function localFilePath(key: string): string {
  assertKey(key);
  const root = getLocalDir();
  const file = path.resolve(/*turbopackIgnore: true*/ root, ...key.split("/"));
  // Belt and braces: the regex already forbids `..`, but never serve outside root.
  if (file !== root && !file.startsWith(root + path.sep)) {
    throw new Error("Media kaliti noto'g'ri");
  }
  return file;
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Content type from the key's extension (the local driver keeps no metadata). */
export function contentTypeForKey(key: string): string {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function isMethod(value: unknown): value is LocalTokenMethod {
  return value === "put" || value === "get";
}

export function signLocalToken(key: string, exp: number, method: LocalTokenMethod): string {
  return createHmac("sha256", requireEnv("NEXTAUTH_SECRET"))
    .update(`${method}|${key}|${exp}`)
    .digest("hex");
}

/**
 * True only for a token signed for this exact key + method whose expiry is
 * still in the future. Never throws: a malformed input is just `false`.
 */
export function verifyLocalToken(
  key: string,
  token: string,
  exp: number,
  method: LocalTokenMethod
): boolean {
  if (!isValidMediaKey(key) || !isMethod(method)) return false;
  if (typeof token !== "string" || token.length === 0) return false;
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  if (!process.env.NEXTAUTH_SECRET) return false;

  const expected = Buffer.from(signLocalToken(key, exp, method));
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function localUrl(key: string, expiresSec: number, method: LocalTokenMethod): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(expiresSec));
  const url = new URL(`${LOCAL_ROUTE_PREFIX}/${key}`, getBaseUrl());
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("m", method);
  url.searchParams.set("token", signLocalToken(key, exp, method));
  return url.toString();
}

async function isMissing(err: unknown): Promise<boolean> {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = "local" as const;

  async presignPut(
    key: string,
    opts: { contentType: string; contentLength: number; expiresSec: number }
  ): Promise<{ url: string; headers: Record<string, string> }> {
    assertKey(key);
    return {
      url: localUrl(key, opts.expiresSec, "put"),
      headers: {
        "Content-Type": opts.contentType,
        "Content-Length": String(opts.contentLength),
      },
    };
  }

  async presignGet(key: string, expiresSec: number): Promise<string> {
    assertKey(key);
    return localUrl(key, expiresSec, "get");
  }

  async getObject(key: string): Promise<Buffer> {
    return fs.readFile(localFilePath(key));
  }

  async putObject(key: string, body: Buffer, _contentType: string): Promise<void> {
    const file = localFilePath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }

  /**
   * Streams an upload straight to disk (used by the local PUT route). Stops
   * — and removes the partial file — as soon as more than `maxBytes` arrive,
   * so a lying Content-Length cannot fill the disk (M7).
   */
  async putObjectStream(key: string, body: Readable, maxBytes = Number.POSITIVE_INFINITY): Promise<number> {
    const file = localFilePath(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    let written = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        written += chunk.length;
        if (written > maxBytes) done(new UploadTooLargeError());
        else done(null, chunk);
      },
    });
    try {
      await pipeline(body, limit, createWriteStream(file));
    } catch (err) {
      await fs.unlink(file).catch(() => undefined);
      throw err;
    }
    return written;
  }

  async deleteObject(key: string): Promise<void> {
    const file = localFilePath(key);
    try {
      await fs.unlink(file);
    } catch (err) {
      if (!(await isMissing(err))) throw err;
    }
  }

  async headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
    const file = localFilePath(key);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      return { size: stat.size, contentType: contentTypeForKey(key) };
    } catch (err) {
      if (await isMissing(err)) return null;
      throw err;
    }
  }
}
