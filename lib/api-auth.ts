import { NextResponse } from "next/server";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
  type WorkspaceContext,
} from "@/lib/workspace-access";

export type AuthResult =
  | { ok: true; ctx: WorkspaceContext }
  | { ok: false; response: NextResponse };

export function jsonError(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ success: false, error, ...extra }, { status });
}

export function jsonOk<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status });
}

/**
 * Resolve the signed-in user's workspace. `manage: true` additionally requires
 * an owner/admin: `member` is read-only (TZ 9.1) — integration and profile
 * writes are refused with 403.
 */
export async function requireWorkspace(manage = false): Promise<AuthResult> {
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) return { ok: false, response: jsonError("Unauthorized", 401) };
  if (manage && !canManageWorkspace(ctx.role)) {
    return { ok: false, response: jsonError("Forbidden", 403) };
  }
  return { ok: true, ctx };
}
