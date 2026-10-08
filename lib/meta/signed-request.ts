/**
 * Meta `signed_request` (deauthorize and data-deletion callbacks):
 * "<base64url HMAC-SHA256 signature>.<base64url JSON payload>", signed with
 * the app secret. Returns the payload only when the signature matches.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignedRequestPayload {
  algorithm?: string;
  user_id?: string;
  issued_at?: number;
  [key: string]: unknown;
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function parseSignedRequest(signedRequest: string, secrets: string[]): SignedRequestPayload | null {
  const [signaturePart, payloadPart] = signedRequest.split(".", 2);
  if (!signaturePart || !payloadPart) return null;

  const signature = base64UrlDecode(signaturePart);
  const matches = secrets.filter(Boolean).some((secret) => {
    const expected = createHmac("sha256", secret).update(payloadPart).digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  });
  if (!matches) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(payloadPart).toString("utf8")) as SignedRequestPayload;
    if (payload.algorithm && payload.algorithm.toUpperCase() !== "HMAC-SHA256") return null;
    return payload;
  } catch {
    return null;
  }
}

/** Instagram Login callbacks are signed with the Instagram app secret; older setups with the Facebook one. */
export function metaAppSecrets(): string[] {
  return [process.env.INSTAGRAM_APP_SECRET ?? "", process.env.FACEBOOK_APP_SECRET ?? ""];
}

/** Reads `signed_request` from a form-encoded (or JSON) callback body. */
export async function readSignedRequest(request: Request): Promise<string | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as { signed_request?: unknown };
      return typeof body.signed_request === "string" ? body.signed_request : null;
    }
    const form = await request.formData();
    const value = form.get("signed_request");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
