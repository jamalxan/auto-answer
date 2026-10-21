import { protectedResourceMetadata, publicOrigin } from "@/lib/mcp/oauth";
import { metadataResponse } from "@/lib/mcp/oauth-http";

export const dynamic = "force-dynamic";

/** RFC 9728 §3.1 path-suffixed variant: /.well-known/oauth-protected-resource/api/mcp for the resource /api/mcp. */
export async function GET(request: Request) {
  return metadataResponse(protectedResourceMetadata(publicOrigin(request)));
}

export async function OPTIONS() {
  return metadataResponse(null);
}
