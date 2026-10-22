/**
 * Content Scheduler — media storage.
 *
 * One `StorageDriver` interface, two implementations:
 *   - S3-compatible (AWS S3, Cloudflare R2, MinIO …) via @aws-sdk/client-s3,
 *     presigned PUT/GET so the browser talks to the bucket directly;
 *   - local filesystem (lib/content/storage-local.ts) for dev / self-host.
 *
 * Driver choice: MEDIA_STORAGE_DRIVER=s3|local, defaulting to s3 when
 * MEDIA_S3_BUCKET is set and local otherwise.
 *
 * Env (S3): MEDIA_S3_ENDPOINT (optional — omit for real AWS), MEDIA_S3_REGION
 * (default `auto`), MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY, MEDIA_S3_SECRET_KEY,
 * MEDIA_S3_FORCE_PATH_STYLE (default `1`; R2/MinIO need it).
 * Env (local): MEDIA_LOCAL_DIR (default `.media`), NEXTAUTH_URL, NEXTAUTH_SECRET.
 */

import { randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { LocalStorageDriver } from "./storage-local";

export { isValidMediaKey, MEDIA_KEY_RE } from "./storage-local";

export interface StorageDriver {
  presignPut(
    key: string,
    opts: { contentType: string; contentLength: number; expiresSec: number }
  ): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, expiresSec: number): Promise<string>;
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<{ size: number; contentType?: string } | null>;
}

export type StorageDriverName = "s3" | "local";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function flag(name: string, defaultValue: boolean): boolean {
  const raw = env(name).toLowerCase();
  if (raw === "") return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes";
}

export function getStorageDriverName(): StorageDriverName {
  const raw = env("MEDIA_STORAGE_DRIVER").toLowerCase();
  if (raw === "s3" || raw === "local") return raw;
  return env("MEDIA_S3_BUCKET") ? "s3" : "local";
}

interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

function readS3Config(): S3Config | null {
  const bucket = env("MEDIA_S3_BUCKET");
  const accessKey = env("MEDIA_S3_ACCESS_KEY");
  const secretKey = env("MEDIA_S3_SECRET_KEY");
  if (!bucket || !accessKey || !secretKey) return null;
  return {
    endpoint: env("MEDIA_S3_ENDPOINT") || undefined,
    region: env("MEDIA_S3_REGION") || "auto",
    bucket,
    accessKey,
    secretKey,
    forcePathStyle: flag("MEDIA_S3_FORCE_PATH_STYLE", true),
  };
}

/** True when the selected driver has everything it needs to sign URLs. */
export function isStorageConfigured(): boolean {
  if (getStorageDriverName() === "local") return env("NEXTAUTH_SECRET").length > 0;
  return readS3Config() !== null;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]+$/;

/** cuid-like: base36 timestamp + 16 random bytes in base36, lowercase only. */
function newMediaId(): string {
  const ts = Date.now().toString(36);
  const rand = BigInt(`0x${randomBytes(16).toString("hex")}`).toString(36);
  return `c${ts}${rand}`;
}

/** `ws/<wsId>/<yyyy>/<mm>/<cuid>.<ext>` — month from UTC. */
export function mediaKey(workspaceId: string, ext: string, now: Date = new Date()): string {
  const cleanExt = ext.replace(/^\.+/, "").toLowerCase();
  if (!ID_RE.test(workspaceId)) throw new Error("Workspace id noto'g'ri");
  if (!ID_RE.test(cleanExt)) throw new Error("Fayl kengaytmasi noto'g'ri");
  const yyyy = String(now.getUTCFullYear()).padStart(4, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `ws/${workspaceId}/${yyyy}/${mm}/${newMediaId()}.${cleanExt}`;
}

// ---------------------------------------------------------------------------
// S3 driver
// ---------------------------------------------------------------------------

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

export class S3StorageDriver implements StorageDriver {
  readonly name = "s3" as const;
  readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      // Flexible checksums (SDK ≥ 3.729) would add x-amz-checksum-* to every
      // presigned PUT, which the browser cannot supply and R2/MinIO reject.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async presignPut(
    key: string,
    opts: { contentType: string; contentLength: number; expiresSec: number }
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: opts.expiresSec,
      // The presigner leaves content-type unsigned by default; sign both so the
      // uploaded object can only be what the server approved.
      signableHeaders: new Set(["content-type", "content-length"]),
    });
    return {
      url,
      headers: {
        "Content-Type": opts.contentType,
        "Content-Length": String(opts.contentLength),
      },
    };
  }

  async presignGet(key: string, expiresSec: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresSec,
    });
  }

  async getObject(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error("Media topilmadi");
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      })
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? undefined };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cached: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (cached) return cached;
  if (getStorageDriverName() === "local") {
    cached = new LocalStorageDriver();
    return cached;
  }
  const cfg = readS3Config();
  if (!cfg) {
    throw new Error(
      "Media saqlash (S3) sozlanmagan: MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY va MEDIA_S3_SECRET_KEY kerak"
    );
  }
  cached = new S3StorageDriver(cfg);
  return cached;
}

export function isLocalStorageActive(): boolean {
  return getStorageDriverName() === "local";
}

/** Drops the cached driver so env stubs take effect in tests. */
export function resetStorageForTests(): void {
  if (cached instanceof S3StorageDriver) cached.client.destroy();
  cached = null;
}
