import { authorizationServerMetadata, publicOrigin } from "@/lib/mcp/oauth";
import { metadataResponse } from "@/lib/mcp/oauth-http";

export const dynamic = "force-dynamic";

/** RFC 8414: where to register, authorize and get tokens for /api/mcp. Public. */
export async function GET(request: Request) {
  return metadataResponse(authorizationServerMetadata(publicOrigin(request)));
}

export async function OPTIONS() {
  return metadataResponse(null);
}
