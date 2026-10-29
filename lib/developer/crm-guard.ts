import type { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { can, isReadOnlyRole, PERMISSION_LABELS, type Permission } from "@/lib/workspace-permissions";
import type { ServiceResult } from "@/lib/crm/result";
import { firstIssue } from "@/lib/crm/result";
import { requireWorkspace, type WorkspaceAuth } from "@/lib/channels/guard";

/**
 * Guards for /api/crm (ETAP 5). On top of the developer login and
 * the app session (requireWorkspace) every handler names the TZ 53 permission
 * it needs; writes additionally refuse the read-only VIEWER role. Reads need
 * `view_contacts` (every role has it), contact-level writes `assign_leads`
 * (OPERATOR+), configuration writes and broadcasts `manage_campaigns`
 * (MANAGER+), exports `export_data`.
 */
export async function requireCrm(permission: Permission, options: { write?: boolean } = {}): Promise<WorkspaceAuth> {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth;
  if (options.write && isReadOnlyRole(auth.ctx.role)) {
    return { ok: false, response: jsonError("Kuzatuvchi (VIEWER) rolida o'zgartirish mumkin emas", 403) };
  }
  if (!can(auth.ctx.role, permission)) {
    return { ok: false, response: jsonError(`Ruxsat yo'q: ${PERMISSION_LABELS[permission]}`, 403) };
  }
  return auth;
}

export const NOT_JSON = "So'rov JSON emas";

/** Body as JSON, or null when missing / malformed (the route answers 400). */
export async function readJson(request: NextRequest): Promise<unknown | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? body : null;
}

/** 400 with the first zod issue, or the parsed value. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): ServiceResult<T> {
  if (body === null || body === undefined) return { ok: false, status: 400, error: NOT_JSON };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, error: firstIssue(parsed.error) };
  return { ok: true, data: parsed.data };
}

/** `{ success, data }` or `{ success: false, error }` with the service's status. */
export function respond<T>(result: ServiceResult<T>, status = 200): NextResponse {
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data, status);
}
