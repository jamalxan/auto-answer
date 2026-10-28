import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { cancelDmExecutionFollowUps } from "@/lib/triggers/dm-trigger-service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Cancels the scheduled follow-ups of one Direct / Story Mention execution. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const result = await cancelDmExecutionFollowUps(auth.ctx.workspaceId, id);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data);
}
