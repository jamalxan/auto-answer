/**
 * ETAP 12 — MCP tokens: create, list, revoke (developer area).
 *
 * The raw token (`sa_mcp_<random>`) exists only in the answer of createToken;
 * the database keeps its sha256 and the last 4 characters. Every query is
 * scoped by the workspace the developer guard resolved.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { firstIssue } from "@/lib/crm/result";
import { MAX_TOKENS_PER_WORKSPACE, TOKEN_PREFIX } from "./config";
import { badRequest, conflict, notFound } from "./errors";

export const TOKEN_NOT_FOUND = "Token topilmadi";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function generateRawToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export const createTokenSchema = z.object({
  name: z.string().trim().min(1, "Token nomini kiriting").max(80, "Nom 80 belgidan oshmasin"),
  scope: z.enum(["READ", "WRITE"], "Ruxsat READ yoki WRITE bo'lishi kerak").default("READ"),
  /** Days until the token stops working; omitted = no expiry. */
  expiresInDays: z.number().int("Kun butun son bo'lsin").min(1).max(365).optional(),
  /** Default true: confirm_action over MCP is refused and a person approves in /developer/mcp. Opt out explicitly. */
  requireHumanApproval: z.boolean("requireHumanApproval true yoki false bo'lsin").default(true),
});
export type CreateTokenInput = z.infer<typeof createTokenSchema>;

export interface TokenView {
  id: string;
  name: string;
  scope: "READ" | "WRITE";
  requireHumanApproval: boolean;
  tokenHint: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

type TokenRow = TokenView & { workspaceId: string; tokenHash: string; createdByUserId: string | null };

/** Whitelist: the hash never leaves this layer. */
function view(row: TokenRow): TokenView {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    requireHumanApproval: row.requireHumanApproval !== false,
    tokenHint: row.tokenHint,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export async function createToken(workspaceId: string, input: unknown, userId: string | null, now: Date = new Date()): Promise<{ token: string; view: TokenView }> {
  const parsed = createTokenSchema.safeParse(input);
  if (!parsed.success) throw badRequest(firstIssue(parsed.error));
  const body = parsed.data;
  const active = await prisma.mcpToken.count({ where: { workspaceId, revokedAt: null } });
  if (active >= MAX_TOKENS_PER_WORKSPACE) {
    throw conflict(`Faol tokenlar ko'pi bilan ${MAX_TOKENS_PER_WORKSPACE} ta. Yechim: keraksiz tokenni bekor qiling.`);
  }
  const raw = generateRawToken();
  const row = (await prisma.mcpToken.create({
    data: {
      workspaceId,
      name: body.name,
      tokenHash: hashToken(raw),
      tokenHint: raw.slice(-4),
      scope: body.scope,
      requireHumanApproval: body.requireHumanApproval,
      createdByUserId: userId,
      expiresAt: body.expiresInDays ? new Date(now.getTime() + body.expiresInDays * 86_400_000) : null,
    },
  })) as unknown as TokenRow;
  return { token: raw, view: view(row) };
}

export async function listTokens(workspaceId: string): Promise<TokenView[]> {
  const rows = (await prisma.mcpToken.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100 })) as unknown as TokenRow[];
  return rows.map(view);
}

/** Revokes the token and withdraws what it had proposed but nobody confirmed yet. */
export async function revokeToken(workspaceId: string, tokenId: string, now: Date = new Date()): Promise<void> {
  const revoked = await prisma.mcpToken.updateMany({ where: { id: tokenId, workspaceId, revokedAt: null }, data: { revokedAt: now } });
  if (revoked.count === 0) {
    const exists = await prisma.mcpToken.findFirst({ where: { id: tokenId, workspaceId }, select: { id: true } });
    if (!exists) throw notFound(TOKEN_NOT_FOUND);
    return; // already revoked: idempotent
  }
  await prisma.mcpAction.updateMany({
    where: { tokenId, workspaceId, status: "PROPOSED" },
    data: { status: "REJECTED", confirmCodeHash: null, error: "Token bekor qilindi", resolvedAt: now },
  });
}
