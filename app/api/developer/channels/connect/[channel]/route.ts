import { NextResponse, type NextRequest } from "next/server";
import { facebookAuthorizeUrl } from "@/lib/channels/facebook";
import { threadsAuthorizeUrl } from "@/lib/channels/threads";
import { youtubeAuthorizeUrl } from "@/lib/channels/youtube";
import { requireDeveloper } from "@/lib/developer/access";
import { getBaseUrl } from "@/lib/env";
import { createOAuthState } from "@/lib/meta/oauth";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ channel: string }> };

const AUTHORIZE: Record<string, (redirectUri: string, state: string) => string> = {
  facebook: facebookAuthorizeUrl,
  threads: threadsAuthorizeUrl,
  youtube: youtubeAuthorizeUrl,
};

/** Start the OAuth flow of a vault channel; the callback stores the tokens in the vault. */
export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { channel } = await params;
  const authorize = AUTHORIZE[channel];
  const back = `${getBaseUrl()}/developer/channels`;
  if (!authorize) return NextResponse.redirect(`${back}?error=${encodeURIComponent("Noma'lum kanal")}`);
  try {
    const state = createOAuthState(auth.ctx.workspaceId, "/developer/channels");
    return NextResponse.redirect(authorize(`${getBaseUrl()}/api/developer/channels/callback/${channel}`, state));
  } catch (error) {
    return NextResponse.redirect(`${back}?error=${encodeURIComponent(error instanceof Error ? error.message : "Sozlanmagan")}`);
  }
}
