import { NextRequest } from "next/server";
import { parseBody, requireCrm, respond } from "@/lib/developer/crm-guard";
import { z } from "zod";
import { listRecipients, recipientsQuerySchema } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const querySchema = recipientsQuerySchema.extend({
  replied: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** ?status= &reason= &replied=true &cursor= &limit= */
export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const query = parseBody(querySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await listRecipients(auth.ctx.workspaceId, id, query.data));
}
