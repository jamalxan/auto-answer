import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import {
  campaignInputSchema,
  deleteCampaign,
  firstIssue,
  getCampaign,
  setCampaignActive,
  updateCampaign,
} from "@/lib/triggers/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const campaign = await getCampaign(auth.ctx.workspaceId, id);
  if (!campaign) return jsonError("Not found", 404);
  return jsonOk({ campaign });
}

export async function PUT(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const parsed = campaignInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await updateCampaign(auth.ctx.workspaceId, id, parsed.data);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ campaign: result.campaign });
}

const toggleSchema = z.object({ active: z.boolean() });

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const parsed = toggleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("active: boolean kerak", 400);

  const updated = await setCampaignActive(auth.ctx.workspaceId, id, parsed.data.active);
  if (!updated) return jsonError("Not found", 404);
  return jsonOk({ id, active: parsed.data.active });
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const deleted = await deleteCampaign(auth.ctx.workspaceId, id);
  if (!deleted) return jsonError("Not found", 404);
  return jsonOk({ id });
}
