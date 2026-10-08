import { NextResponse } from "next/server";
import { deauthorizeInstagramUser } from "@/lib/meta/account-revocation";
import { metaAppSecrets, parseSignedRequest, readSignedRequest } from "@/lib/meta/signed-request";

export const dynamic = "force-dynamic";

/**
 * Meta "Deauthorize callback URL": called when an Instagram user removes the
 * app. The account is disconnected the same way as the in-app button.
 */
export async function POST(request: Request) {
  const signedRequest = await readSignedRequest(request);
  const payload = signedRequest ? parseSignedRequest(signedRequest, metaAppSecrets()) : null;
  if (!payload?.user_id) {
    return NextResponse.json({ success: false, error: "Invalid signed_request" }, { status: 400 });
  }

  const accounts = await deauthorizeInstagramUser(String(payload.user_id));
  console.log(`[Meta deauthorize] user ${payload.user_id}: ${accounts} account(s) disconnected`);
  return NextResponse.json({ success: true });
}
