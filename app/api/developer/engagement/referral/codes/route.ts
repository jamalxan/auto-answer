import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { codeCreateSchema, codesQuerySchema, createReferralCode, listCodes, programScope, referralLink, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

/** Codes of a program with their counters and a ready-to-share link: ?programId= &cursor= &limit= */
export async function GET(request: NextRequest) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const query = parseBody(codesQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  const { workspaceId } = auth.ctx;
  return respond(
    await run(async () => {
      const scope = await programScope(workspaceId, query.data.programId);
      const page = await listCodes(workspaceId, scope.programId, query.data);
      return {
        ...page,
        items: page.items.map((item) => ({ ...item, link: scope.username ? referralLink(scope.username, item.code) : null })),
      };
    })
  );
}

/** { programId, contactId | igUserId }: idempotent per referrer. */
export async function POST(request: NextRequest) {
  const auth = await requireEngagement("config");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(codeCreateSchema, body);
  if (!parsed.ok) return respond(parsed);
  const { workspaceId } = auth.ctx;
  return respond(
    await run(async () => {
      const scope = await programScope(workspaceId, parsed.data.programId);
      const code = await createReferralCode(workspaceId, scope.programId, { contactId: parsed.data.contactId, igUserId: parsed.data.igUserId });
      return { code, link: scope.username ? referralLink(scope.username, code.code) : null };
    }),
    201
  );
}
