/**
 * ETAP 12 — bearer-token authentication of /api/mcp.
 *
 * The raw token is hashed (sha256) and looked up by the unique hash, so the
 * comparison never runs over the secret itself; the stored hash is then
 * compared again in constant time. Revoked and expired tokens are refused.
 * Each token is limited to RATE_LIMIT_PER_MIN requests per rolling minute
 * (per server process, like the other in-process guards; documented in README).
 */

import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { INVALID_TOKEN_PER_IP_PER_MIN, LAST_USED_WRITE_MS, MAX_TOKEN_LENGTH, RATE_LIMIT_PER_MIN, TOKEN_PREFIX } from "./config";
import { describeError } from "./errors";
import { hashToken } from "./tokens";

export interface McpTokenContext {
  tokenId: string;
  workspaceId: string;
  scope: "READ" | "WRITE";
  name: string;
  /** true: confirm_action over MCP is refused and a person approves in /developer/mcp. */
  requireHumanApproval: boolean;
}

export type McpAuthResult =
  | { ok: true; ctx: McpTokenContext }
  | { ok: false; status: 401 | 429; error: string; retryAfterSec?: number };

export const MISSING_TOKEN = "Token kerak: Authorization: Bearer sa_mcp_… sarlavhasini yuboring";
export const INVALID_TOKEN = "Token noto'g'ri";
export const REVOKED_TOKEN = "Token bekor qilingan. Yechim: /developer/mcp da yangi token yarating.";
export const EXPIRED_TOKEN = "Token muddati tugagan. Yechim: /developer/mcp da yangi token yarating.";
export const RATE_LIMITED = `So'rovlar juda ko'p: daqiqada ${RATE_LIMIT_PER_MIN} tadan oshmasin. Birozdan keyin qayta urinib ko'ring.`;

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

/** Failed token lookups per client IP (bounded; in memory, per process). */
const MAX_TRACKED_IPS = 5000;
const badLookups = new Map<string, number[]>();

export function resetMcpRateLimitsForTests() {
  hits.clear();
  badLookups.clear();
}

function ipBlocked(ip: string | null, nowMs: number): boolean {
  if (!ip) return false;
  const recent = (badLookups.get(ip) ?? []).filter((t) => t > nowMs - WINDOW_MS);
  return recent.length >= INVALID_TOKEN_PER_IP_PER_MIN;
}

function noteBadLookup(ip: string | null, nowMs: number) {
  if (!ip) return;
  const recent = (badLookups.get(ip) ?? []).filter((t) => t > nowMs - WINDOW_MS);
  recent.push(nowMs);
  badLookups.delete(ip); // re-insert so Map order stays oldest-first
  badLookups.set(ip, recent);
  if (badLookups.size > MAX_TRACKED_IPS) {
    for (const key of badLookups.keys()) {
      if (badLookups.size <= MAX_TRACKED_IPS) break;
      badLookups.delete(key);
    }
  }
}

/** Counts this request; not allowed when the token already used its minute. */
function takeSlot(tokenId: string, nowMs: number): { allowed: boolean; retryAfterSec: number } {
  const recent = (hits.get(tokenId) ?? []).filter((t) => t > nowMs - WINDOW_MS);
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    hits.set(tokenId, recent);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + WINDOW_MS - nowMs) / 1000)) };
  }
  recent.push(nowMs);
  hits.set(tokenId, recent);
  return { allowed: true, retryAfterSec: 0 };
}

export function bearerOf(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function authenticateMcp(authorization: string | null, now: Date = new Date(), clientIp: string | null = null): Promise<McpAuthResult> {
  const raw = bearerOf(authorization);
  if (!raw) return { ok: false, status: 401, error: MISSING_TOKEN };
  if (ipBlocked(clientIp, now.getTime())) return { ok: false, status: 429, error: RATE_LIMITED, retryAfterSec: 60 };
  if (!raw.startsWith(TOKEN_PREFIX) || raw.length > MAX_TOKEN_LENGTH) {
    noteBadLookup(clientIp, now.getTime());
    return { ok: false, status: 401, error: INVALID_TOKEN };
  }

  const hash = hashToken(raw);
  const row = await prisma.mcpToken.findUnique({ where: { tokenHash: hash } });
  if (!row || !sameHash(row.tokenHash, hash)) {
    noteBadLookup(clientIp, now.getTime());
    return { ok: false, status: 401, error: INVALID_TOKEN };
  }
  if (row.revokedAt) return { ok: false, status: 401, error: REVOKED_TOKEN };
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return { ok: false, status: 401, error: EXPIRED_TOKEN };

  const slot = takeSlot(row.id, now.getTime());
  if (!slot.allowed) return { ok: false, status: 429, error: RATE_LIMITED, retryAfterSec: slot.retryAfterSec };

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_WRITE_MS) {
    try {
      await prisma.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: now } });
    } catch (error) {
      console.error("[MCP] lastUsedAt write failed:", describeError(error));
    }
  }
  return { ok: true, ctx: { tokenId: row.id, workspaceId: row.workspaceId, scope: row.scope, name: row.name, requireHumanApproval: row.requireHumanApproval !== false } };
}
