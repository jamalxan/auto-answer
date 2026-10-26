import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import {
  getStorage,
  isStorageConfigured,
  mediaKey,
  resetStorageForTests,
} from "@/lib/content/storage";
import {
  isValidMediaKey,
  signLocalToken,
  verifyLocalToken,
} from "@/lib/content/storage-local";

const KEY = "ws/ws1/2026/10/abc123.jpg";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "content-storage-"));
  vi.stubEnv("MEDIA_STORAGE_DRIVER", "local");
  vi.stubEnv("MEDIA_LOCAL_DIR", tmpDir);
  vi.stubEnv("MEDIA_S3_BUCKET", "");
  vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-test-secret-test-secret");
  resetStorageForTests();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetStorageForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("mediaKey", () => {
  it("builds ws/<wsId>/<yyyy>/<mm>/<id>.<ext>", () => {
    const key = mediaKey("ws1", "jpg", new Date("2026-10-22T10:00:00Z"));
    expect(key).toMatch(/^ws\/ws1\/2026\/10\/[a-z0-9]+\.jpg$/);
    expect(isValidMediaKey(key)).toBe(true);
  });

  it("zero-pads the month and lowercases the extension", () => {
    const key = mediaKey("ws1", "JPG", new Date("2026-03-01T00:00:00Z"));
    expect(key).toMatch(/^ws\/ws1\/2026\/03\/[a-z0-9]+\.jpg$/);
  });

  it("generates unique ids", () => {
    const a = mediaKey("ws1", "png");
    const b = mediaKey("ws1", "png");
    expect(a).not.toBe(b);
  });
});

describe("key validation", () => {
  it("accepts base, prepared and thumb variants", () => {
    expect(isValidMediaKey("ws/ws1/2026/10/abc-123.jpg")).toBe(true);
    expect(isValidMediaKey("ws/ws1/2026/10/abc123.prepared.jpg")).toBe(true);
    expect(isValidMediaKey("ws/ws1/2026/10/abc123.thumb.jpg")).toBe(true);
  });

  it("rejects path traversal and foreign shapes", () => {
    expect(isValidMediaKey("../x")).toBe(false);
    expect(isValidMediaKey("ws/ws1/2026/10/../../etc/passwd")).toBe(false);
    expect(isValidMediaKey("ws/ws1/2026/10/abc.jpg/..")).toBe(false);
    expect(isValidMediaKey("ws/WS1/2026/10/abc.jpg")).toBe(false);
    expect(isValidMediaKey("ws/ws1/2026/10/abc.other.jpg")).toBe(false);
    expect(isValidMediaKey("/ws/ws1/2026/10/abc.jpg")).toBe(false);
    expect(isValidMediaKey("")).toBe(false);
  });
});

describe("local driver", () => {
  it("is selected and configured when MEDIA_S3_BUCKET is unset", () => {
    expect(isStorageConfigured()).toBe(true);
  });

  it("round-trips put → head → get → delete under MEDIA_LOCAL_DIR", async () => {
    const storage = getStorage();
    expect(await storage.headObject(KEY)).toBeNull();

    await storage.putObject(KEY, Buffer.from("hello"), "image/jpeg");
    const onDisk = await fs.readFile(path.join(tmpDir, ...KEY.split("/")));
    expect(onDisk.toString()).toBe("hello");

    const head = await storage.headObject(KEY);
    expect(head).toEqual({ size: 5, contentType: "image/jpeg" });

    const body = await storage.getObject(KEY);
    expect(body.toString()).toBe("hello");

    await storage.deleteObject(KEY);
    expect(await storage.headObject(KEY)).toBeNull();
    await expect(storage.getObject(KEY)).rejects.toThrow();
    // deleting a missing object is idempotent
    await expect(storage.deleteObject(KEY)).resolves.toBeUndefined();
  });

  it("rejects invalid keys on every operation", async () => {
    const storage = getStorage();
    await expect(storage.putObject("../x", Buffer.from("a"), "text/plain")).rejects.toThrow();
    await expect(storage.getObject("../x")).rejects.toThrow();
    await expect(storage.headObject("../x")).rejects.toThrow();
    await expect(storage.deleteObject("../x")).rejects.toThrow();
    await expect(
      storage.presignPut("../x", { contentType: "text/plain", contentLength: 1, expiresSec: 60 })
    ).rejects.toThrow();
    await expect(storage.presignGet("../x", 60)).rejects.toThrow();
  });

  it("presignPut returns a local URL with a token that verifies for PUT only", async () => {
    const storage = getStorage();
    const before = Math.floor(Date.now() / 1000);
    const { url, headers } = await storage.presignPut(KEY, {
      contentType: "image/jpeg",
      contentLength: 1234,
      expiresSec: 600,
    });
    expect(headers).toEqual({ "Content-Type": "image/jpeg", "Content-Length": "1234" });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://localhost:3000");
    expect(parsed.pathname).toBe(`/api/content/media/local/${KEY}`);
    expect(parsed.searchParams.get("m")).toBe("put");
    const exp = Number(parsed.searchParams.get("exp"));
    expect(exp).toBeGreaterThanOrEqual(before + 600);
    expect(exp).toBeLessThanOrEqual(before + 602);
    const token = parsed.searchParams.get("token");
    expect(token).toBeTruthy();

    expect(verifyLocalToken(KEY, token!, exp, "put")).toBe(true);
    expect(verifyLocalToken(KEY, token!, exp, "get")).toBe(false);
    expect(verifyLocalToken(KEY, token!, exp - 1, "put")).toBe(false);
    expect(verifyLocalToken("ws/ws1/2026/10/other.jpg", token!, exp, "put")).toBe(false);
    expect(verifyLocalToken(KEY, token!.slice(0, -2) + "zz", exp, "put")).toBe(false);
  });

  it("presignGet returns a GET-method URL", async () => {
    const storage = getStorage();
    const url = new URL(await storage.presignGet(KEY, 60));
    expect(url.pathname).toBe(`/api/content/media/local/${KEY}`);
    expect(url.searchParams.get("m")).toBe("get");
    const exp = Number(url.searchParams.get("exp"));
    expect(verifyLocalToken(KEY, url.searchParams.get("token")!, exp, "get")).toBe(true);
    expect(verifyLocalToken(KEY, url.searchParams.get("token")!, exp, "put")).toBe(false);
  });

  it("rejects an expired token", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = signLocalToken(KEY, past, "get");
    expect(verifyLocalToken(KEY, token, past, "get")).toBe(false);
  });

  it("rejects garbage tokens without throwing", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(verifyLocalToken(KEY, "", exp, "get")).toBe(false);
    expect(verifyLocalToken(KEY, "nope", exp, "get")).toBe(false);
    expect(verifyLocalToken(KEY, "x".repeat(64), Number.NaN, "get")).toBe(false);
  });
});

describe("local route", () => {
  async function loadRoute() {
    return import("@/app/api/content/media/local/[...key]/route");
  }

  function ctx(key: string) {
    return { params: Promise.resolve({ key: key.split("/") }) };
  }

  it("PUT writes the body, GET streams it back", async () => {
    const route = await loadRoute();
    const storage = getStorage();
    const { url, headers } = await storage.presignPut(KEY, {
      contentType: "image/jpeg",
      contentLength: 3,
      expiresSec: 60,
    });
    const putRes = await route.PUT(
      new NextRequest(url, { method: "PUT", headers, body: Buffer.from("abc") }),
      ctx(KEY)
    );
    expect(putRes.status).toBe(200);
    expect(await storage.getObject(KEY)).toEqual(Buffer.from("abc"));

    const getUrl = await storage.presignGet(KEY, 60);
    const getRes = await route.GET(new NextRequest(getUrl), ctx(KEY));
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/jpeg");
    expect(getRes.headers.get("content-length")).toBe("3");
    expect(await getRes.text()).toBe("abc");
  });

  it("GET returns 403 for a bad or expired token and 404 for a missing file", async () => {
    const route = await loadRoute();
    const storage = getStorage();
    const okUrl = new URL(await storage.presignGet(KEY, 60));
    expect((await route.GET(new NextRequest(okUrl), ctx(KEY))).status).toBe(404);

    const bad = new URL(okUrl);
    bad.searchParams.set("token", "deadbeef");
    expect((await route.GET(new NextRequest(bad), ctx(KEY))).status).toBe(403);

    const past = Math.floor(Date.now() / 1000) - 5;
    const expired = new URL(okUrl);
    expired.searchParams.set("exp", String(past));
    expired.searchParams.set("token", signLocalToken(KEY, past, "get"));
    expect((await route.GET(new NextRequest(expired), ctx(KEY))).status).toBe(403);

    // a PUT token must not be usable for GET
    const put = await storage.presignPut(KEY, { contentType: "image/jpeg", contentLength: 1, expiresSec: 60 });
    expect((await route.GET(new NextRequest(put.url), ctx(KEY))).status).toBe(403);
  });

  it("rejects traversal keys and refuses oversized PUT bodies", async () => {
    const route = await loadRoute();
    const exp = Math.floor(Date.now() / 1000) + 60;
    const evil = "../x";
    const url = `http://localhost:3000/api/content/media/local/${evil}?exp=${exp}&m=get&token=${signLocalToken(evil, exp, "get")}`;
    // an invalid key is "no such file" (404), so the route reveals nothing about what exists
    expect((await route.GET(new NextRequest(url), ctx(evil))).status).toBe(404);

    const big = await getStorage().presignPut(KEY, {
      contentType: "image/jpeg",
      contentLength: 2 * 1024 * 1024 * 1024,
      expiresSec: 60,
    });
    const res = await route.PUT(
      new NextRequest(big.url, { method: "PUT", headers: big.headers, body: Buffer.from("abc") }),
      ctx(KEY)
    );
    expect(res.status).toBe(413);
  });

  it("stops a body longer than its Content-Length and leaves no file behind (M7)", async () => {
    const route = await loadRoute();
    const storage = getStorage();
    const { url, headers } = await storage.presignPut(KEY, { contentType: "image/jpeg", contentLength: 3, expiresSec: 60 });
    const req = new NextRequest(url, { method: "PUT", headers, body: Buffer.from("abcdefgh") });
    const res = await route.PUT(req, ctx(KEY));
    expect(res.status).toBe(400);
    expect(await storage.headObject(KEY)).toBeNull();
  });

  it("is a 404 when the local driver is not active", async () => {
    vi.stubEnv("MEDIA_STORAGE_DRIVER", "s3");
    vi.stubEnv("MEDIA_S3_BUCKET", "bucket");
    vi.stubEnv("MEDIA_S3_ACCESS_KEY", "ak");
    vi.stubEnv("MEDIA_S3_SECRET_KEY", "sk");
    resetStorageForTests();
    const route = await loadRoute();
    const exp = Math.floor(Date.now() / 1000) + 60;
    const url = `http://localhost:3000/api/content/media/local/${KEY}?exp=${exp}&m=get&token=${signLocalToken(KEY, exp, "get")}`;
    expect((await route.GET(new NextRequest(url), ctx(KEY))).status).toBe(404);
  });
});

describe("s3 driver", () => {
  beforeEach(() => {
    vi.stubEnv("MEDIA_STORAGE_DRIVER", "");
    vi.stubEnv("MEDIA_S3_BUCKET", "test-bucket");
    vi.stubEnv("MEDIA_S3_ENDPOINT", "http://127.0.0.1:9000");
    vi.stubEnv("MEDIA_S3_ACCESS_KEY", "AKIATEST");
    vi.stubEnv("MEDIA_S3_SECRET_KEY", "secret");
    resetStorageForTests();
  });

  it("is the default when MEDIA_S3_BUCKET is set", () => {
    expect(isStorageConfigured()).toBe(true);
  });

  it("is not configured without credentials", () => {
    vi.stubEnv("MEDIA_S3_SECRET_KEY", "");
    resetStorageForTests();
    expect(isStorageConfigured()).toBe(false);
  });

  it("builds a presigned PUT URL that pins bucket, content type and length (no network)", async () => {
    const storage = getStorage();
    const { url, headers } = await storage.presignPut(KEY, {
      contentType: "image/jpeg",
      contentLength: 42,
      expiresSec: 300,
    });
    expect(headers).toEqual({ "Content-Type": "image/jpeg", "Content-Length": "42" });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://127.0.0.1:9000");
    expect(parsed.pathname).toBe(`/test-bucket/${KEY}`);
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("300");
    const signed = parsed.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed.split(";")).toEqual(expect.arrayContaining(["content-length", "content-type", "host"]));
    // flexible checksum headers would force the browser to send x-amz-checksum-*; they must stay out
    expect(signed).not.toContain("x-amz-checksum");
    expect(parsed.searchParams.has("x-amz-sdk-checksum-algorithm")).toBe(false);
  });

  it("builds a presigned GET URL", async () => {
    const parsed = new URL(await getStorage().presignGet(KEY, 120));
    expect(parsed.pathname).toBe(`/test-bucket/${KEY}`);
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("caches the client between calls and resets on demand", () => {
    const a = getStorage();
    expect(getStorage()).toBe(a);
    resetStorageForTests();
    expect(getStorage()).not.toBe(a);
  });
});
