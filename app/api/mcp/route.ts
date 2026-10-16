import { handleMcpPost, methodNotAllowed } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

/** MCP Streamable HTTP endpoint (ETAP 12). Bearer-token auth; see lib/mcp/README.md. */
export async function POST(request: Request) {
  return handleMcpPost(request);
}

export async function GET() {
  return methodNotAllowed();
}

export async function DELETE() {
  return methodNotAllowed();
}
