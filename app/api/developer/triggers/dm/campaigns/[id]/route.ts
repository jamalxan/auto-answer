import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { NOT_FOUND } from "@/lib/triggers/campaign-editing";
import {
  deleteDmCampaign,
  dmCampaignSchema,
  firstIssue,
  getDmCampaign,
  setDmCampaignActive,
  toggleSchema,
  updateDmCampaign,
} from "@/lib/triggers/dm-trigger-service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const campaign = await getDmCampaign(auth.ctx.workspaceId, id);
  if (!campaign) return jsonError(NOT_FOUND, 404);
  return jsonOk({ campaign });
}

/** `{ active }` alone toggles the campaign; anything else is a full settings save. */
export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);

  const toggle = toggleSchema.safeParse(body);
  if (toggle.success) {
    const updated = await setDmCampaignActive(auth.ctx.workspaceId, id, toggle.data.active);
    if (!updated) return jsonError(NOT_FOUND, 404);
    return jsonOk({ id, active: toggle.data.active });
  }

  const parsed = dmCampaignSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);
  const result = await updateDmCampaign(auth.ctx.workspaceId, id, parsed.data);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ campaign: result.data });
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const deleted = await deleteDmCampaign(auth.ctx.workspaceId, id);
  if (!deleted) return jsonError(NOT_FOUND, 404);
  return jsonOk({ id });
}
