import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { CrossPostError, deleteCrossPost, editCrossPost, listCrossPosts, setTelegramTargets } from "@/lib/channels/crosspost";
import { ChannelError } from "@/lib/channels/types";
import { requireDeveloper } from "@/lib/developer/access";
import { getBotUsername, isTelegramConfigured } from "@/lib/telegram/api";
import {
  RIGHT_LABELS,
  disconnectChannel,
  listBusinessConnections,
  listInbox,
  listTelegramChannels,
  recheckChannel,
  replyToChannelMessage,
} from "@/lib/telegram/channel";

export const dynamic = "force-dynamic";

const KINDS = new Set(["comment", "channel_dm", "business_dm"]);

/** Telegram channel module (audit T3): channels, Business connections, inbox, cross-posts. */
export async function GET(request: NextRequest) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  const kind = request.nextUrl.searchParams.get("kind");
  const workspaceId = auth.ctx.workspaceId;
  const [channels, business, inbox, posts] = await Promise.all([
    listTelegramChannels(workspaceId),
    listBusinessConnections(workspaceId),
    listInbox(workspaceId, { kind: kind && KINDS.has(kind) ? kind : undefined }),
    listCrossPosts(workspaceId),
  ]);
  return jsonOk({
    configured: isTelegramConfigured(),
    botUsername: getBotUsername(),
    rightLabels: RIGHT_LABELS,
    channels,
    business,
    inbox,
    posts,
  });
}

type Body = { action?: unknown; id?: unknown; text?: unknown; postId?: unknown; channelIds?: unknown };

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as Body | null;
  const workspaceId = auth.ctx.workspaceId;
  const id = str(body?.id);
  try {
    switch (body?.action) {
      case "recheck": {
        if (!id) return jsonError("id kerak", 400);
        const channel = await recheckChannel(workspaceId, id);
        return channel ? jsonOk({ channel }) : jsonError("Topilmadi", 404);
      }
      case "disconnect":
        if (!id) return jsonError("id kerak", 400);
        return (await disconnectChannel(workspaceId, id)) ? jsonOk({ ok: true }) : jsonError("Topilmadi", 404);
      case "reply": {
        const text = str(body.text);
        if (!id || !text) return jsonError("id va text kerak", 400);
        const result = await replyToChannelMessage(workspaceId, id, text, auth.ctx.userId);
        return result.ok ? jsonOk(result) : jsonError(result.error, 409);
      }
      case "set_targets": {
        const postId = str(body.postId);
        const channelIds = Array.isArray(body.channelIds) ? body.channelIds.filter((c): c is string => typeof c === "string") : null;
        if (!postId || !channelIds) return jsonError("postId va channelIds kerak", 400);
        return jsonOk({ targets: await setTelegramTargets(workspaceId, postId, channelIds) });
      }
      case "edit_post": {
        const text = str(body.text);
        if (!id || !text) return jsonError("id va text kerak", 400);
        await editCrossPost(workspaceId, id, text);
        return jsonOk({ ok: true });
      }
      case "delete_post":
        if (!id) return jsonError("id kerak", 400);
        return (await deleteCrossPost(workspaceId, id)) ? jsonOk({ ok: true }) : jsonError("Ba'zi xabarlar o'chmadi — botning o'chirish huquqini tekshiring", 409);
      default:
        return jsonError("Noma'lum action", 400);
    }
  } catch (error) {
    if (error instanceof CrossPostError) return jsonError(error.message, error.status);
    if (error instanceof ChannelError) return jsonError(error.message, error.kind === "rate_limit" ? 429 : 409);
    throw error;
  }
}
