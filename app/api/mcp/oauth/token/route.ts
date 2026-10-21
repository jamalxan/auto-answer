import { handleTokenPost, methodNotAllowed } from "@/lib/mcp/oauth-http";

export const dynamic = "force-dynamic";

/** OAuth token endpoint: authorization_code (+ PKCE) and refresh_token grants. The access token is an McpToken. */
export async function POST(request: Request) {
  return handleTokenPost(request);
}

export async function GET() {
  return methodNotAllowed("POST");
}
