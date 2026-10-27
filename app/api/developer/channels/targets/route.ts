import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { CrossPostError, VAULT_CHANNELS, listCrossPosts, setChannelTargets } from "@/lib/channels/crosspost";
import type { ChannelId } from "@/lib/channels/types";
import { requireDeveloper } from "@/lib/developer/access";

export const dynamic = "force-dynamic";

/** Content Scheduler posts with their cross-post targets. */
export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  return jsonOk({ posts: await listCrossPosts(auth.ctx.workspaceId) });
}

/** { postId, channel, accountIds } — replaces that channel's targets of the post. */
export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as { postId?: unknown; channel?: unknown; accountIds?: unknown } | null;
  if (!body || typeof body.postId !== "string" || typeof body.channel !== "string" || !VAULT_CHANNELS.has(body.channel as ChannelId)) {
    return jsonError("postId, channel (facebook | threads | youtube) kerak", 400);
  }
  const ids = Array.isArray(body.accountIds) ? body.accountIds.filter((v): v is string => typeof v === "string").slice(0, 20) : [];
  try {
    return jsonOk({ targets: await setChannelTargets(auth.ctx.workspaceId, body.postId, body.channel as ChannelId, ids) });
  } catch (error) {
    if (error instanceof CrossPostError) return jsonError(error.message, error.status);
    throw error;
  }
}
