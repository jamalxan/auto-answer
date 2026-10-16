import McpDashboard from "@/components/developer/mcp/mcp-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "MCP / AI Control (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout.
export default function McpPage() {
  return <McpDashboard />;
}
