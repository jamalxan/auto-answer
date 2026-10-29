import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { disqualifyEntry, entryActionSchema, markEntry, requireEntry, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; entryId: string }> };

/** { action: "mark-eligible" | "mark-ineligible" | "disqualify", reason } */
export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("winners");
  if (!auth.ok) return auth.response;
  const { id, entryId } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(entryActionSchema, body);
  if (!parsed.ok) return respond(parsed);
  const { action, reason } = parsed.data;
  if (action !== "mark-eligible" && !reason) return jsonError("Sababini yozing: bu amal jurnalga yoziladi", 400);
  const { workspaceId, userId } = auth.ctx;
  return respond(
    await run(async () => {
      await requireEntry(workspaceId, id, entryId);
      if (action === "disqualify") return disqualifyEntry(workspaceId, id, entryId, userId, reason as string);
      return markEntry(workspaceId, id, entryId, action === "mark-eligible" ? "ELIGIBLE" : "INELIGIBLE", userId, reason);
    })
  );
}
