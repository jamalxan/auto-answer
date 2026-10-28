import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { CONVERSATION_NOT_FOUND, getConversation } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const conversation = await getConversation(auth.ctx.workspaceId, id);
  if (!conversation) return jsonError(CONVERSATION_NOT_FOUND, 404);
  return jsonOk({ conversation });
}
