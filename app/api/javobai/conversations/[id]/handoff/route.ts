import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { firstIssue, handoffActionSchema, runHandoffAction } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** `{ action: "accept" | "close" | "reopen", resumeAi? }` */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = handoffActionSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await runHandoffAction(auth.ctx.workspaceId, id, parsed.data, auth.ctx.userId);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data);
}
