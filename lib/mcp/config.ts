/**
 * ETAP 12 — MCP / AI control layer: switches and limits.
 *
 * MCP_DISABLED=1 is the kill switch: /api/mcp answers 503 and every tool stops
 * (tokens can still be listed and revoked in /developer/mcp).
 */

export function isMcpEnabled(): boolean {
  const flag = (process.env.MCP_DISABLED ?? "").trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}

/** Raw tokens look like `sa_mcp_<random>`; only their sha256 is stored. */
export const TOKEN_PREFIX = "sa_mcp_";
/** Longest Authorization token we even hash (a longer one cannot be ours). */
export const MAX_TOKEN_LENGTH = 200;
/** Requests per token per rolling minute. */
export const RATE_LIMIT_PER_MIN = 60;
/** JSON-RPC body cap (bytes). */
export const MAX_BODY_BYTES = 256 * 1024;
/** A proposed write can be confirmed for this long. */
export const CONFIRM_TTL_MS = 10 * 60 * 1000;
/** Active (not revoked) tokens per workspace. */
export const MAX_TOKENS_PER_WORKSPACE = 10;
/** lastUsedAt is written at most this often per token. */
export const LAST_USED_WRITE_MS = 60 * 1000;
/** Proposed-but-unsettled actions per token (a runaway client cannot flood the log). */
export const MAX_PENDING_ACTIONS = 20;
/** Largest tool answer sent back (characters); longer text is cut. */
export const MAX_RESULT_CHARS = 60_000;
/** Rows a list tool may return. */
export const MAX_LIST_LIMIT = 50;

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_INFO = { name: "socialauto", version: "0.1.0" } as const;

export const MCP_OFF_MESSAGE = "MCP o'chirilgan (MCP_DISABLED). Yechim: serverda MCP_DISABLED ni olib tashlab, web'ni qayta ishga tushiring.";
