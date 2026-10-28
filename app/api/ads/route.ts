import { NextRequest } from "next/server";
import { AdsError, adsOverview, approveProposal, pauseProposal, rejectProposal, resumeProposal, revokeAdAccount, updateAdAccount, type AccountSettings } from "@/lib/ads/service";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";

export const dynamic = "force-dynamic";

/** Ad accounts (caps, today / month spend) and boost proposals. */
export async function GET() {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  return jsonOk({ ...(await adsOverview(auth.ctx.workspaceId)), role: auth.ctx.role });
}

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);

/**
 * { action: "settings", id, ...AccountSettings } | { action: "approve", id, dailyBudgetMinor?, durationDays?, objective? }
 * | { action: "reject" | "pause" | "resume", id } | { action: "revoke", id }
 * Approve, resume and settings: workspace OWNER only (checked in the service).
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.id !== "string") return jsonError("id kerak", 400);
  const { workspaceId, userId, role } = auth.ctx;
  try {
    switch (body.action) {
      case "settings": {
        const settings: AccountSettings = {};
        for (const key of ["pageId", "igUserId", "datasetId"] as const) if (key in body) settings[key] = typeof body[key] === "string" ? (body[key] as string) : null;
        for (const key of ["dailyCapMinor", "monthlyCapMinor", "cplMaxMinor", "defaultDailyBudgetMinor", "saleValueMinor"] as const) {
          if (key in body) settings[key] = body[key] === null ? null : int(body[key]) ?? null;
        }
        await updateAdAccount(workspaceId, body.id, settings, role);
        return jsonOk({ ok: true });
      }
      case "approve": {
        const objective = body.objective === "ENGAGEMENT" || body.objective === "MESSAGES" ? body.objective : undefined;
        const proposal = await approveProposal({ workspaceId, proposalId: body.id, userId, role, dailyBudgetMinor: int(body.dailyBudgetMinor), durationDays: int(body.durationDays), objective });
        return jsonOk({ proposal });
      }
      case "reject":
        return (await rejectProposal(workspaceId, body.id)) ? jsonOk({ ok: true }) : jsonError("Taklif topilmadi", 404);
      case "pause":
        return jsonOk({ proposal: await pauseProposal(workspaceId, body.id) });
      case "resume":
        return jsonOk({ proposal: await resumeProposal(workspaceId, body.id, role) });
      case "revoke":
        return (await revokeAdAccount(workspaceId, body.id)) ? jsonOk({ ok: true }) : jsonError("Topilmadi", 404);
      default:
        return jsonError("action: settings | approve | reject | pause | resume | revoke", 400);
    }
  } catch (error) {
    if (error instanceof AdsError) return jsonError(error.message, error.status);
    throw error;
  }
}
