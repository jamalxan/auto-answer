import type { NextResponse } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import type { ServiceResult } from "@/lib/crm/result";
import { can, isReadOnlyRole, PERMISSION_LABELS, type Permission } from "@/lib/workspace-permissions";
import { requireWorkspace, type WorkspaceAuth } from "@/lib/channels/guard";

export { NOT_JSON, parseBody, readJson } from "./crm-guard";

/**
 * Guards for /api/engagement (ETAP 9). On top of the developer
 * login and the app session (requireWorkspace) every handler names the TZ 53
 * permission it needs; writes additionally refuse the read-only VIEWER role.
 *
 *   read    -> view_contacts   (every role)
 *   config  -> manage_campaigns (MANAGER+): create / edit giveaways, referral
 *              program, gamification settings, codes, activate, close, backfill
 *   winners -> manage_campaigns (MANAGER+): draw, confirm, disqualify, notify,
 *              mark entries. An OPERATOR therefore cannot draw.
 *   export  -> export_data     (MANAGER+)
 */
export const ENGAGEMENT_ACCESS = {
  read: { permission: "view_contacts", write: false },
  config: { permission: "manage_campaigns", write: true },
  winners: { permission: "manage_campaigns", write: true },
  export: { permission: "export_data", write: false },
} as const satisfies Record<string, { permission: Permission; write: boolean }>;

export type EngagementAccess = keyof typeof ENGAGEMENT_ACCESS;

export async function requireEngagement(access: EngagementAccess): Promise<WorkspaceAuth> {
  const { permission, write } = ENGAGEMENT_ACCESS[access];
  const auth = await requireWorkspace();
  if (!auth.ok) return auth;
  if (write && isReadOnlyRole(auth.ctx.role)) {
    return { ok: false, response: jsonError("Kuzatuvchi (VIEWER) rolida o'zgartirish mumkin emas", 403) };
  }
  if (!can(auth.ctx.role, permission)) {
    return { ok: false, response: jsonError(`Ruxsat yo'q: ${PERMISSION_LABELS[permission]}`, 403) };
  }
  return auth;
}

/** Removes the encrypted seed from anything an engine hands back, at any depth. */
export function stripSeeds<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSeeds) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "seedEncrypted") continue;
      out[key] = stripSeeds(inner);
    }
    return out as T;
  }
  return value;
}

/** `{ success, data }` or `{ success: false, error }`; the encrypted seed can never be serialized. */
export function respond<T>(result: ServiceResult<T>, status = 200): NextResponse {
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(stripSeeds(result.data), status);
}

/** Draw sequence from the URL, or null (the route answers 400). */
export function parseSequence(raw: string): number | null {
  return /^\d{1,6}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;
}
