/**
 * ETAP 12 — types and helpers of the MCP developer screen. Client-safe: no server imports.
 */

import type { DisplayTone } from "@/lib/triggers/display";

export { jsonInit, requestJson, type JsonResult } from "@/components/developer/comments/shared";

export const MCP_API = "/api/developer/mcp";

export interface McpMeta {
  enabled: boolean;
  endpoint: string;
  workspace: { id: string; name: string } | null;
  limits: { ratePerMin: number; maxBodyBytes: number; confirmMinutes: number; maxTokens: number; tokenPrefix: string };
  tools: Array<{ name: string; scope: "READ" | "WRITE"; kind: "read" | "write" | "control"; description: string }>;
  me: { canManage: boolean };
}

export interface TokenRow {
  id: string;
  name: string;
  scope: "READ" | "WRITE";
  requireHumanApproval: boolean;
  tokenHint: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreatedToken {
  token: string;
  view: TokenRow;
}

export interface ActionRow {
  id: string;
  tokenId: string;
  tokenName: string | null;
  tool: string;
  status: string;
  summary: string;
  preview: unknown;
  result: unknown;
  error: string | null;
  approvedBy?: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}

export const ACTION_STATUS: Record<string, { label: string; tone: DisplayTone }> = {
  PROPOSED: { label: "Tasdiq kutilmoqda", tone: "warning" },
  CONFIRMED: { label: "Bajarilmoqda", tone: "warning" },
  EXECUTED: { label: "Bajarildi", tone: "success" },
  REJECTED: { label: "Rad etildi", tone: "muted" },
  EXPIRED: { label: "Muddati tugadi", tone: "muted" },
  FAILED: { label: "Xato", tone: "error" },
};

export function tokenState(token: TokenRow, now = Date.now()): { label: string; tone: DisplayTone } {
  if (token.revokedAt) return { label: "Bekor qilingan", tone: "muted" };
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= now) return { label: "Muddati tugagan", tone: "error" };
  return { label: "Faol", tone: "success" };
}

/** The commands a person pastes into their AI client. */
export function connectionSnippets(endpoint: string, token: string) {
  return {
    claudeCode: `claude mcp add --transport http socialauto ${endpoint} --header "Authorization: Bearer ${token}"`,
    claudeDesktop: JSON.stringify(
      { mcpServers: { socialauto: { command: "npx", args: ["-y", "mcp-remote", endpoint, "--header", `Authorization: Bearer ${token}`] } } },
      null,
      2
    ),
    url: endpoint,
  };
}
