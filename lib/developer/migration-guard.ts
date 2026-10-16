import { NextRequest, NextResponse } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { readLimitedJson } from "@/lib/utils/limited-body";
import { isMigrationEnabled } from "@/lib/migration/config";
import { can, isReadOnlyRole, PERMISSION_LABELS, type Permission } from "@/lib/workspace-permissions";
import type { ServiceResult } from "@/lib/crm/result";
import { requireDeveloper, type DeveloperAuth } from "./access";

export { NOT_JSON, parseBody, readJson } from "./crm-guard";

/**
 * Guards for /api/developer/migration (ETAP 11). On top of the developer
 * login and the app session (requireDeveloper):
 *
 *   read     `view_contacts` (every role): projects, items, meta
 *   write    `manage_campaigns`, not VIEWER: connect, analyze, mapping, text, basics import
 *   convert  `manage_campaigns`, not VIEWER: AI conversion and the draft import (spends AI budget)
 *   preview  `manage_campaigns`, not VIEWER: pure text analysis (no kill switch, nothing stored)
 *   delete   `manage_campaigns`, not VIEWER: also allowed while the kill switch is on, because
 *            wiping the stored ManyChat key must always be possible
 *
 * `write` and `convert` answer 503 (Uzbek, with the fix) while MIGRATION_DISABLED is on.
 */
export type MigrationAccess = "read" | "write" | "convert" | "preview" | "delete";

export const MIGRATION_OFF_MESSAGE =
  "Migratsiya o'chirilgan (MIGRATION_DISABLED). Yechim: serverda MIGRATION_DISABLED ni olib tashlab, web'ni qayta ishga tushiring. Loyihani o'chirish mumkin.";

export async function requireMigration(access: MigrationAccess): Promise<DeveloperAuth> {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth;
  const permission: Permission = access === "read" ? "view_contacts" : "manage_campaigns";
  if (access !== "read" && isReadOnlyRole(auth.ctx.role)) {
    return { ok: false, response: jsonError("Kuzatuvchi (VIEWER) rolida o'zgartirish mumkin emas", 403) };
  }
  if (!can(auth.ctx.role, permission)) {
    return { ok: false, response: jsonError(`Ruxsat yo'q: ${PERMISSION_LABELS[permission]}`, 403) };
  }
  if ((access === "write" || access === "convert") && !isMigrationEnabled()) {
    return { ok: false, response: jsonError(MIGRATION_OFF_MESSAGE, 503) };
  }
  return auth;
}

const SECRET_KEYS = new Set(["apikey", "apikeyencrypted", "api_key", "x-api-key", "authorization"]);

/** Defence in depth: the ManyChat key must never leave the server, whatever the engine returns. */
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key.toLowerCase())) continue;
      out[key] = stripSecrets(v);
    }
    return out as T;
  }
  return value;
}

/** `{ success, data }` (secrets stripped) or `{ success: false, error }`. */
export function respondSafe<T>(result: ServiceResult<T>, status = 200): NextResponse {
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(stripSecrets(result.data), status);
}

/** Rejects a body that is obviously larger than `maxBytes` before it is read. */
export function tooLarge(request: NextRequest, maxBytes: number): NextResponse | null {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > maxBytes) {
    return jsonError("So'rov juda katta. Yechim: rasmlarni kichraytiring yoki sonini kamaytiring, matnni qisqartiring.", 413);
  }
  return null;
}

const TOO_LARGE_MESSAGE = "So'rov juda katta. Yechim: rasmlarni kichraytiring yoki sonini kamaytiring, matnni qisqartiring.";

export type LimitedJson = { ok: true; value: unknown } | { ok: false; response: NextResponse };

/**
 * Reads the JSON body with a hard byte cap that does not trust Content-Length: the stream is
 * counted chunk by chunk and cancelled with 413 as soon as `maxBytes` is crossed, so a spoofed
 * header or a chunked upload never reaches JSON.parse unbounded. `value` is the parsed JSON,
 * `undefined` for an empty body and `null` for malformed JSON.
 */
export async function readJsonLimited(request: NextRequest, maxBytes: number): Promise<LimitedJson> {
  const result = await readLimitedJson(request, maxBytes);
  if (!result.ok) return { ok: false, response: jsonError(TOO_LARGE_MESSAGE, 413) };
  return result;
}

/** Object body (or null when missing / malformed) under a byte cap; the 413 response is returned as `response`. */
export async function readJsonObjectLimited(request: NextRequest, maxBytes: number): Promise<{ body: object | null; response?: NextResponse }> {
  const result = await readJsonLimited(request, maxBytes);
  if (!result.ok) return { body: null, response: result.response };
  const value = result.value;
  return { body: value && typeof value === "object" ? value : null };
}

/** Caps of the JSON bodies (bytes). */
export const BODY_LIMITS = { small: 64 * 1024, importGraph: 1024 * 1024 } as const;
