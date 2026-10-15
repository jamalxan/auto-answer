import type { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { jsonError } from "@/lib/api-auth";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
  type WorkspaceContext,
} from "@/lib/workspace-access";
import { getDeveloperSession } from "./auth";

/**
 * Guards for everything under /developer and /api/developer.
 *
 * Two keys are needed: the developer login (lib/developer/auth) and a normal
 * signed-in app session, because every developer module works on the
 * signed-in user's workspace. Nothing here widens tenant access.
 */

export type DeveloperAuth =
  | { ok: true; ctx: WorkspaceContext }
  | { ok: false; response: NextResponse };

/**
 * API guard. Without a developer session the route answers a plain 404, so
 * the API looks like it does not exist. `manage` additionally requires an
 * owner/admin of the workspace, same as every other write in the app.
 */
export async function requireDeveloper(manage = false): Promise<DeveloperAuth> {
  if (!(await getDeveloperSession())) {
    return { ok: false, response: jsonError("Not found", 404) };
  }
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) return { ok: false, response: jsonError("Unauthorized", 401) };
  if (manage && !canManageWorkspace(ctx.role)) {
    return { ok: false, response: jsonError("Forbidden", 403) };
  }
  return { ok: true, ctx };
}

/** Page guard: sends a missing developer login to /developer/login. */
export async function requireDeveloperPage(): Promise<WorkspaceContext> {
  if (!(await getDeveloperSession())) redirect("/developer/login");
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) redirect("/login?callbackUrl=/developer");
  return ctx;
}
