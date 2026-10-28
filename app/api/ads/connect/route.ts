import { NextResponse } from "next/server";
import { adsAuthorizeUrl } from "@/lib/ads/meta-ads";
import { requireWorkspace } from "@/lib/channels/guard";
import { flashRedirect } from "@/lib/flash-server";
import { getBaseUrl } from "@/lib/env";
import { createOAuthState } from "@/lib/meta/oauth";

export const dynamic = "force-dynamic";

/** Start Facebook Login with the ads scopes (ads_management, ads_read, business_management). */
export async function GET() {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  try {
    const state = createOAuthState(auth.ctx.workspaceId, "/ads");
    return NextResponse.redirect(adsAuthorizeUrl(`${getBaseUrl()}/api/ads/callback`, state));
  } catch (error) {
    return flashRedirect("/ads", { tone: "error", text: error instanceof Error ? error.message : "Sozlanmagan" });
  }
}
