import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { createAutoReply, deleteAutoReply, listAutoReplies, listAutoReplyLog, setAutoReplyEnabled, updateAutoReply } from "@/lib/channels/auto-reply";
import { requireWorkspace } from "@/lib/channels/guard";
import { ChannelError } from "@/lib/channels/types";
import { canManageWorkspace } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

/** Rules + the latest auto-replies that went out (or failed). */
export async function GET() {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const [rules, log] = await Promise.all([listAutoReplies(auth.ctx.workspaceId), listAutoReplyLog(auth.ctx.workspaceId)]);
  return jsonOk({ rules, log, canManage: canManageWorkspace(auth.ctx.role) });
}

/** { action: "create"|"update"|"toggle"|"delete", id?, rule?, enabled? } */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as { action?: unknown; id?: unknown; rule?: unknown; enabled?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const ws = auth.ctx.workspaceId;
  try {
    switch (body?.action) {
      case "create":
        return jsonOk({ rule: await createAutoReply(ws, body.rule) });
      case "update":
        if (!id) return jsonError("id kerak", 400);
        return jsonOk({ rule: await updateAutoReply(ws, id, body.rule) });
      case "toggle":
        if (!id || typeof body.enabled !== "boolean") return jsonError("id va enabled kerak", 400);
        await setAutoReplyEnabled(ws, id, body.enabled);
        return jsonOk({ ok: true });
      case "delete":
        if (!id) return jsonError("id kerak", 400);
        await deleteAutoReply(ws, id);
        return jsonOk({ ok: true });
      default:
        return jsonError("action: create | update | toggle | delete", 400);
    }
  } catch (error) {
    if (error instanceof ChannelError) return jsonError(error.message, 400);
    throw error;
  }
}
