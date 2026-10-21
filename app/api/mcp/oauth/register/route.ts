import { handleRegisterPost, methodNotAllowed } from "@/lib/mcp/oauth-http";

export const dynamic = "force-dynamic";

/** OAuth 2.0 dynamic client registration (RFC 7591) for MCP clients. Anonymous, throttled per IP. */
export async function POST(request: Request) {
  return handleRegisterPost(request);
}

export async function GET() {
  return methodNotAllowed("POST");
}
