import { NextResponse } from "next/server";
import { deleteInstagramUserData, deletionConfirmationCode } from "@/lib/meta/account-revocation";
import { metaAppSecrets, parseSignedRequest, readSignedRequest } from "@/lib/meta/signed-request";
import { getBaseUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Meta "Data deletion request URL". Deletes what we hold about the Instagram
 * user and answers in the format Meta requires: a status URL and a
 * confirmation code the user can quote.
 */
export async function POST(request: Request) {
  const signedRequest = await readSignedRequest(request);
  const payload = signedRequest ? parseSignedRequest(signedRequest, metaAppSecrets()) : null;
  if (!payload?.user_id) {
    return NextResponse.json({ error: "Invalid signed_request" }, { status: 400 });
  }

  const userId = String(payload.user_id);
  const accounts = await deleteInstagramUserData(userId);
  const code = deletionConfirmationCode(userId, payload.issued_at);
  console.log(`[Meta data deletion] user ${userId}: ${accounts} account(s), code ${code}`);

  return NextResponse.json({
    url: `${getBaseUrl()}/data-deletion?code=${code}`,
    confirmation_code: code,
  });
}
