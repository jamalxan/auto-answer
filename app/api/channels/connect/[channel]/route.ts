import { NextResponse, type NextRequest } from "next/server";
import { facebookAuthorizeUrl } from "@/lib/channels/facebook";
import { threadsAuthorizeUrl } from "@/lib/channels/threads";
import { youtubeAuthorizeUrl } from "@/lib/channels/youtube";
import { requireWorkspace } from "@/lib/channels/guard";
import { flashRedirect } from "@/lib/flash-server";
import { getBaseUrl } from "@/lib/env";
import { createOAuthState } from "@/lib/meta/oauth";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ channel: string }> };

const AUTHORIZE: Record<string, (redirectUri: string, state: string, options?: { classic?: boolean }) => string> = {
  facebook: facebookAuthorizeUrl,
  threads: threadsAuthorizeUrl,
  youtube: youtubeAuthorizeUrl,
};

/** Start the OAuth flow of a vault channel; the callback stores the tokens in the vault. */
export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { channel } = await params;
  const authorize = AUTHORIZE[channel];
  if (!authorize) return flashRedirect("/channels", { tone: "error", text: "Noma'lum kanal" });
  try {
    const state = createOAuthState(auth.ctx.workspaceId, "/channels");
    return NextResponse.redirect(authorize(`${getBaseUrl()}/api/channels/callback/${channel}`, state, { classic: request.nextUrl.searchParams.get("classic") !== "0" }));
  } catch (error) {
    return flashRedirect("/channels", { tone: "error", text: error instanceof Error ? error.message : "Sozlanmagan" });
  }
}
