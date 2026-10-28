import type { NextResponse } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { canManageWorkspace, getCurrentWorkspaceContext, type WorkspaceContext } from "@/lib/workspace-access";

export type WorkspaceAuth = { ok: true; ctx: WorkspaceContext } | { ok: false; response: NextResponse };

/**
 * Guard of /api/channels and /api/ads (Facebook, Threads, YouTube, Meta ads),
 * promoted from /developer to the main dashboard. The signed-in app session
 * picks the workspace. Reads are open to every role; `manage` (connect,
 * disconnect, reply, cross-post targets, ad caps and approvals) needs an
 * owner or admin, same as every other write in the app.
 */
export async function requireWorkspace(manage = false): Promise<WorkspaceAuth> {
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) return { ok: false, response: jsonError("Unauthorized", 401) };
  if (manage && !canManageWorkspace(ctx.role)) {
    return { ok: false, response: jsonError("Faqat workspace egasi yoki admin o'zgartira oladi", 403) };
  }
  return { ok: true, ctx };
}
