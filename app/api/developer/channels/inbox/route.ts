import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { hideInboxComment, listChannelInbox, replyToInboxMessage, type ReplyMode } from "@/lib/channels/inbox";
import { ChannelError, type ChannelId } from "@/lib/channels/types";
import { requireDeveloper } from "@/lib/developer/access";

export const dynamic = "force-dynamic";

const CHANNELS = new Set(["facebook", "threads", "youtube"]);
const MODES = new Set<ReplyMode>(["public", "private", "dm"]);

/** Facebook / Threads / YouTube inbox (comments, Messenger). */
export async function GET(request: NextRequest) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  const channel = request.nextUrl.searchParams.get("channel");
  return jsonOk({ messages: await listChannelInbox(auth.ctx.workspaceId, channel && CHANNELS.has(channel) ? (channel as ChannelId) : undefined) });
}

/** { action: "reply", id, text, mode } | { action: "hide", id, hide } */
export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as { action?: unknown; id?: unknown; text?: unknown; mode?: unknown; hide?: unknown } | null;
  if (!body || typeof body.id !== "string") return jsonError("id kerak", 400);
  try {
    if (body.action === "reply") {
      if (typeof body.text !== "string" || !MODES.has(body.mode as ReplyMode)) return jsonError("text va mode (public | private | dm) kerak", 400);
      const sent = await replyToInboxMessage(auth.ctx.workspaceId, body.id, body.text.slice(0, 2000), body.mode as ReplyMode, auth.ctx.userId);
      return jsonOk({ message: sent });
    }
    if (body.action === "hide") {
      await hideInboxComment(auth.ctx.workspaceId, body.id, body.hide !== false);
      return jsonOk({ ok: true });
    }
    return jsonError("action: reply | hide", 400);
  } catch (error) {
    if (error instanceof ChannelError) return jsonError(error.message, error.kind === "auth" || error.kind === "window_closed" ? 409 : 422);
    throw error;
  }
}
