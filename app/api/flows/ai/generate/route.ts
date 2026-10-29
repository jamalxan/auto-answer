import { NextRequest } from "next/server";
import { z } from "zod";
import { parseBody, readJson, requireFlows, respond } from "@/lib/developer/flows-guard";
import { generateFlowFromPrompt } from "@/lib/flows/ai-builder";
import { FLOW_TRIGGER_TYPES } from "@/lib/flows/schema";
import { run } from "@/lib/flows/service";

export const dynamic = "force-dynamic";
// The model call may take up to ~45 s (+ one repair round).
export const maxDuration = 120;

const bodySchema = z.object({
  request: z.string().trim().min(1, "So'rov kiritilmagan").max(2000),
  accountId: z.string().min(1, "Instagram akkaunt tanlanmagan"),
  triggerType: z.enum(FLOW_TRIGGER_TYPES).optional(),
});

/** Generates a draft graph + verdicts. Nothing is saved: the UI saves it as a draft on request. */
export async function POST(request: NextRequest) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const body = parseBody(bodySchema, await readJson(request));
  if (!body.ok) return respond(body);
  return respond(
    await run(() =>
      generateFlowFromPrompt(auth.ctx.workspaceId, {
        request: body.data.request,
        accountId: body.data.accountId,
        triggerType: body.data.triggerType,
      })
    )
  );
}
