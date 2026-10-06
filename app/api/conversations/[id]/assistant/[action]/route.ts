import { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; action: string }> };

/**
 * `POST /api/conversations/{id}/assistant/pause|resume` — the inbox's
 * "Botni to'xtatish / qayta yoqish" button. `id` is our Conversation id.
 * Resuming also clears an operator pause.
 */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id, action } = await params;
  if (action !== "pause" && action !== "resume") return jsonError("Unknown action", 404);

  const conversation = await prisma.conversation.findFirst({
    where: { id, workspaceId: auth.ctx.workspaceId },
    select: { id: true },
  });
  if (!conversation) return jsonError("Not found", 404);

  await prisma.conversation.update({
    where: { id },
    data:
      action === "pause"
        ? { botPaused: true }
        : { botPaused: false, operatorActiveUntil: null },
  });
  return jsonOk({ botPaused: action === "pause" });
}
