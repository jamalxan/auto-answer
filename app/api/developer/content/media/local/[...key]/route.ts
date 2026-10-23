import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getStorage, isLocalStorageActive } from "@/lib/content/storage";
import {
  LocalStorageDriver,
  contentTypeForKey,
  isValidMediaKey,
  localFilePath,
  verifyLocalToken,
  type LocalTokenMethod,
} from "@/lib/content/storage-local";

export const dynamic = "force-dynamic";

/**
 * Local media driver endpoint (dev / self-host only).
 *
 * There is no session here: the HMAC token in the URL (minted by
 * LocalStorageDriver.presignPut / presignGet) is the whole authorization,
 * so the browser can upload and read exactly like against a presigned S3
 * URL. With the S3 driver active the route does not exist (404).
 */

const MAX_PUT_BYTES = 1024 * 1024 * 1024; // 1 GiB

type Ctx = { params: Promise<{ key: string[] }> };

function text(status: number, body: string) {
  return new NextResponse(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** Resolves driver + key + token; returns a response on any failure. */
async function authorize(
  request: NextRequest,
  ctx: Ctx,
  method: LocalTokenMethod
): Promise<{ ok: true; key: string; driver: LocalStorageDriver } | { ok: false; response: NextResponse }> {
  if (!isLocalStorageActive()) return { ok: false, response: text(404, "Not found") };
  const driver = getStorage();
  if (!(driver instanceof LocalStorageDriver)) return { ok: false, response: text(404, "Not found") };

  const { key: parts } = await ctx.params;
  const key = Array.isArray(parts) ? parts.join("/") : "";
  // An invalid key is a file that does not exist, not a forbidden one: nothing to learn from the status.
  if (!isValidMediaKey(key)) return { ok: false, response: text(404, "Not found") };

  const q = request.nextUrl.searchParams;
  const exp = Number(q.get("exp"));
  const token = q.get("token") ?? "";
  if (q.get("m") !== method || !verifyLocalToken(key, token, exp, method)) {
    return { ok: false, response: text(403, "Forbidden") };
  }
  return { ok: true, key, driver };
}

export async function GET(request: NextRequest, ctx: Ctx) {
  const auth = await authorize(request, ctx, "get");
  if (!auth.ok) return auth.response;

  const head = await auth.driver.headObject(auth.key);
  if (!head) return text(404, "Not found");

  const stream = Readable.toWeb(createReadStream(localFilePath(auth.key))) as ReadableStream;
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": head.contentType ?? contentTypeForKey(auth.key),
      "Content-Length": String(head.size),
      "Cache-Control": "private, max-age=60",
    },
  });
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  const auth = await authorize(request, ctx, "put");
  if (!auth.ok) return auth.response;

  const declared = Number(request.headers.get("content-length"));
  if (!Number.isInteger(declared) || declared < 0) return text(411, "Content-Length kerak");
  if (declared > MAX_PUT_BYTES) return text(413, "Fayl juda katta (maks 1 GiB)");
  if (!request.body) return text(400, "Body bo'sh");

  const written = await auth.driver.putObjectStream(
    auth.key,
    Readable.fromWeb(request.body as import("node:stream/web").ReadableStream)
  );
  if (written !== declared) {
    await auth.driver.deleteObject(auth.key);
    return text(400, "Content-Length body bilan mos emas");
  }
  return NextResponse.json({ success: true, data: { key: auth.key, size: written } });
}
