import type { NextResponse } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { isContentSchedulerEnabled } from "@/lib/content/config";
import { canContent, CONTENT_PERMISSION_LABELS, type ContentPermission } from "@/lib/content/permissions";
import { isReadOnlyRole } from "@/lib/workspace-permissions";
import { requireDeveloper, type DeveloperAuth } from "./access";

export { NOT_JSON, parseBody, readJson, respond } from "./crm-guard";

/**
 * Guards for /api/developer/content (ETAP 13). On top of the developer
 * login and the app session (requireDeveloper) every handler names the
 * content permission it needs (spec FR-A1, lib/content/permissions):
 *
 *   view      every role
 *   create    OPERATOR+ (drafts, uploads, saved texts, duplicate, mark-published)
 *   schedule  MANAGER+ (schedule, publish-now, pause, resume, unschedule, retry, cancel, delete)
 *   approve   MANAGER+ (Faza 2)
 *
 * With CONTENT_SCHEDULER_DISABLED=1 the API answers 404 like any unknown route.
 */
export const CONTENT_ACCESS = {
  view: { permission: "content.view", write: false },
  create: { permission: "content.create", write: true },
  schedule: { permission: "content.schedule", write: true },
  approve: { permission: "content.approve", write: true },
} as const satisfies Record<string, { permission: ContentPermission; write: boolean }>;

export type ContentAccess = keyof typeof CONTENT_ACCESS;

export async function requireContent(access: ContentAccess): Promise<DeveloperAuth> {
  if (!isContentSchedulerEnabled()) return { ok: false, response: jsonError("Not found", 404) as NextResponse };
  const { permission, write } = CONTENT_ACCESS[access];
  const auth = await requireDeveloper();
  if (!auth.ok) return auth;
  if (write && isReadOnlyRole(auth.ctx.role)) {
    return { ok: false, response: jsonError("Kuzatuvchi (VIEWER) rolida o'zgartirish mumkin emas", 403) };
  }
  if (!canContent(auth.ctx.role, permission)) {
    return { ok: false, response: jsonError(`Ruxsat yo'q: ${CONTENT_PERMISSION_LABELS[permission]}`, 403) };
  }
  return auth;
}
