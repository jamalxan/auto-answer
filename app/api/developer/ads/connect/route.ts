import { NextResponse } from "next/server";
import { adsAuthorizeUrl } from "@/lib/ads/meta-ads";
import { requireDeveloper } from "@/lib/developer/access";
import { flashRedirect } from "@/lib/developer/flash-server";
import { getBaseUrl } from "@/lib/env";
import { createOAuthState } from "@/lib/meta/oauth";

export const dynamic = "force-dynamic";

/** Start Facebook Login with the ads scopes (ads_management, ads_read, business_management). */
export async function GET() {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  try {
    const state = createOAuthState(auth.ctx.workspaceId, "/developer/ads");
    return NextResponse.redirect(adsAuthorizeUrl(`${getBaseUrl()}/api/developer/ads/callback`, state));
  } catch (error) {
    return flashRedirect("/developer/ads", { tone: "error", text: error instanceof Error ? error.message : "Sozlanmagan" });
  }
}
