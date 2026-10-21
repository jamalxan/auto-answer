import { protectedResourceMetadata, publicOrigin } from "@/lib/mcp/oauth";
import { metadataResponse } from "@/lib/mcp/oauth-http";

export const dynamic = "force-dynamic";

/** RFC 9728: tells an MCP client which authorization server protects /api/mcp. Public. */
export async function GET(request: Request) {
  return metadataResponse(protectedResourceMetadata(publicOrigin(request)));
}

export async function OPTIONS() {
  return metadataResponse(null);
}
