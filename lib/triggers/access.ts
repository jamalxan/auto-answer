import type { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { jsonError } from "@/lib/api-auth";
import { canManageWorkspace, getCurrentWorkspaceContext, type WorkspaceContext } from "@/lib/workspace-access";
import { isTriggerDevEmail } from "./config";

/** True when the signed-in user may see the dev-only trigger engine. */
export async function isTriggerDevSession(): Promise<boolean> {
  const session = await auth();
  return isTriggerDevEmail(session?.user?.email);
}

export type TriggerDevAuth =
  | { ok: true; ctx: WorkspaceContext }
  | { ok: false; response: NextResponse };

/**
 * API guard for /api/dev/triggers/*. A non-dev user gets a plain 404 so the
 * routes look like they do not exist. `manage` additionally requires an
 * owner/admin of the workspace, same as every other write in the app.
 */
export async function requireTriggerDev(manage = false): Promise<TriggerDevAuth> {
  if (!(await isTriggerDevSession())) {
    return { ok: false, response: jsonError("Not found", 404) };
  }
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) return { ok: false, response: jsonError("Unauthorized", 401) };
  if (manage && !canManageWorkspace(ctx.role)) {
    return { ok: false, response: jsonError("Forbidden", 403) };
  }
  return { ok: true, ctx };
}
