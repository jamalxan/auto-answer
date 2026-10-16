/**
 * ETAP 12 — the propose -> confirm layer. A write tool never executes: it
 * stores a McpAction (PROPOSED) with the validated input, the preview and the
 * sha256 of a one-time confirm code, and answers PREVIEW. Only confirm_action
 * with that code, from the SAME token (same workspace), before expiry, runs it.
 *
 * Atomicity: PROPOSED -> CONFIRMED is one conditional updateMany
 * (status = PROPOSED and not expired), so two concurrent confirms cannot both
 * win; only the winner executes and then settles the row to EXECUTED / FAILED.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { CONFIRM_TTL_MS, MAX_PENDING_ACTIONS } from "./config";
import type { McpTokenContext } from "./auth";
import { conflict, describeError, forbidden, notFound, safeMessage, McpServiceError } from "./errors";
import type { Preview } from "./service";

export const ACTION_NOT_FOUND = "Amal topilmadi (id noto'g'ri yoki boshqa token yaratgan)";
export const WRONG_CODE = "Tasdiqlash kodi noto'g'ri. Kodni preview javobidan aynan nusxalang.";
export const EXPIRED_ACTION = "Amal muddati tugagan (10 daqiqa). Yechim: amalni qaytadan so'rang.";
export const ALREADY_DONE = "Bu amal allaqachon bajarilgan yoki yopilgan — qayta tasdiqlab bo'lmaydi.";
export const TOO_MANY_PENDING = `Tasdiq kutayotgan amallar ko'p (${MAX_PENDING_ACTIONS}). Yechim: avvalgilarini tasdiqlang yoki reject_action bilan bekor qiling.`;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newConfirmCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Codes are shown as XXXX-XXXX; dashes, spaces and case do not matter when sending them back. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function hashCode(actionId: string, code: string): string {
  return createHash("sha256").update(`${actionId}:${normalizeCode(code)}`, "utf8").digest("hex");
}

const display = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

export interface ProposedResult {
  status: "PREVIEW";
  actionId: string;
  tool: string;
  preview: Preview;
  confirmCode: string;
  expiresAt: string;
  next: string;
}

export async function proposeAction(
  ctx: McpTokenContext,
  tool: string,
  stored: unknown,
  preview: Preview,
  now: Date = new Date()
): Promise<ProposedResult> {
  // Old, never-confirmed proposals of this token are closed first so they do not count as pending.
  await prisma.mcpAction.updateMany({
    where: { workspaceId: ctx.workspaceId, tokenId: ctx.tokenId, status: "PROPOSED", expiresAt: { lte: now } },
    data: { status: "EXPIRED", confirmCodeHash: null, resolvedAt: now },
  });
  const pending = await prisma.mcpAction.count({ where: { workspaceId: ctx.workspaceId, tokenId: ctx.tokenId, status: "PROPOSED" } });
  if (pending >= MAX_PENDING_ACTIONS) throw conflict(TOO_MANY_PENDING);

  const expiresAt = new Date(now.getTime() + CONFIRM_TTL_MS);
  // The id is needed to salt the code hash, so the row is created first and the hash is added right after.
  const row = await prisma.mcpAction.create({
    data: { workspaceId: ctx.workspaceId, tokenId: ctx.tokenId, tool, input: json(stored), preview: json(preview), status: "PROPOSED", expiresAt },
  });
  const code = newConfirmCode();
  await prisma.mcpAction.update({ where: { id: row.id }, data: { confirmCodeHash: hashCode(row.id, code) } });
  return {
    status: "PREVIEW",
    actionId: row.id,
    tool,
    preview,
    confirmCode: display(code),
    expiresAt: expiresAt.toISOString(),
    next: "Hech narsa bajarilgani yo'q. Foydalanuvchiga previewni ko'rsating; u rozi bo'lsa confirm_action {actionId, confirmCode} ni chaqiring, aks holda reject_action.",
  };
}

export type Executor = (tool: string, ctx: McpTokenContext, stored: unknown) => Promise<unknown>;

export async function confirmAction(
  ctx: McpTokenContext,
  params: { actionId: string; confirmCode: string },
  execute: Executor,
  now: Date = new Date()
): Promise<{ status: "EXECUTED"; actionId: string; tool: string; result: unknown }> {
  // Same token AND same workspace: another token's action id reads as not found.
  const action = await prisma.mcpAction.findFirst({ where: { id: params.actionId, workspaceId: ctx.workspaceId, tokenId: ctx.tokenId } });
  if (!action) throw notFound(ACTION_NOT_FOUND);
  if (action.status !== "PROPOSED") throw conflict(action.status === "EXPIRED" ? EXPIRED_ACTION : ALREADY_DONE);
  if (action.expiresAt.getTime() <= now.getTime()) {
    await prisma.mcpAction.updateMany({
      where: { id: action.id, status: "PROPOSED" },
      data: { status: "EXPIRED", confirmCodeHash: null, resolvedAt: now },
    });
    throw conflict(EXPIRED_ACTION);
  }
  if (!action.confirmCodeHash || !sameHash(action.confirmCodeHash, hashCode(action.id, params.confirmCode))) throw forbidden(WRONG_CODE);

  // The single-use claim: only one concurrent caller can move PROPOSED -> CONFIRMED.
  const claimed = await prisma.mcpAction.updateMany({
    where: { id: action.id, workspaceId: ctx.workspaceId, tokenId: ctx.tokenId, status: "PROPOSED", expiresAt: { gt: now } },
    data: { status: "CONFIRMED", confirmCodeHash: null },
  });
  if (claimed.count !== 1) throw conflict(ALREADY_DONE);

  try {
    const result = await execute(action.tool, ctx, action.input);
    await prisma.mcpAction.updateMany({
      where: { id: action.id, status: "CONFIRMED" },
      data: { status: "EXECUTED", result: json(result), resolvedAt: new Date() },
    });
    await auditEvent(ctx, action.id, action.tool, "bajarildi", "INFO");
    return { status: "EXECUTED", actionId: action.id, tool: action.tool, result };
  } catch (error) {
    const message = safeMessage(error);
    console.error("[MCP] action failed:", action.tool, describeError(error));
    await prisma.mcpAction.updateMany({
      where: { id: action.id, status: "CONFIRMED" },
      data: { status: "FAILED", error: message, resolvedAt: new Date() },
    });
    await auditEvent(ctx, action.id, action.tool, "bajarilmadi", "WARNING");
    throw error instanceof McpServiceError ? error : new McpServiceError(500, message);
  }
}

export async function rejectAction(ctx: McpTokenContext, params: { actionId: string }, now: Date = new Date()): Promise<{ status: "REJECTED"; actionId: string }> {
  const action = await prisma.mcpAction.findFirst({ where: { id: params.actionId, workspaceId: ctx.workspaceId, tokenId: ctx.tokenId } });
  if (!action) throw notFound(ACTION_NOT_FOUND);
  const closed = await prisma.mcpAction.updateMany({
    where: { id: action.id, workspaceId: ctx.workspaceId, tokenId: ctx.tokenId, status: "PROPOSED" },
    data: { status: "REJECTED", confirmCodeHash: null, resolvedAt: now },
  });
  if (closed.count !== 1) throw conflict(ALREADY_DONE);
  return { status: "REJECTED", actionId: action.id };
}

/** Best-effort line in the platform's operational log (OperationalEvent); the McpAction row stays the audit record. */
async function auditEvent(ctx: McpTokenContext, actionId: string, tool: string, outcome: string, level: "INFO" | "WARNING") {
  try {
    await prisma.operationalEvent.create({
      data: { workspaceId: ctx.workspaceId, source: "SYSTEM", level, message: `MCP: ${tool} ${outcome}`, payload: json({ actionId, tool, tokenId: ctx.tokenId }) },
    });
  } catch (error) {
    console.error("[MCP] audit event failed:", describeError(error));
  }
}

// ─── Developer log (read side) ────────────────────────────────────────────────

export interface ActionView {
  id: string;
  tokenId: string;
  tokenName: string | null;
  tool: string;
  status: string;
  summary: string;
  preview: unknown;
  result: unknown;
  error: string | null;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
}

export const ACTION_STATUSES = ["PROPOSED", "CONFIRMED", "EXECUTED", "REJECTED", "EXPIRED", "FAILED"] as const;

/** The audit log for the developer screen. The confirm-code hash and the stored input are never selected. */
export async function listActions(workspaceId: string, filter: { status?: string; tool?: string; limit?: number } = {}): Promise<ActionView[]> {
  const where: Record<string, unknown> = { workspaceId };
  if (filter.status && (ACTION_STATUSES as readonly string[]).includes(filter.status)) where.status = filter.status;
  if (filter.tool) where.tool = filter.tool;
  const rows = await prisma.mcpAction.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
    include: { token: { select: { name: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    tokenId: r.tokenId,
    tokenName: (r as unknown as { token?: { name: string } | null }).token?.name ?? null,
    tool: r.tool,
    // A proposal nobody confirmed in time reads as expired even before the next sweep closes the row.
    status: r.status === "PROPOSED" && r.expiresAt.getTime() <= Date.now() ? "EXPIRED" : r.status,
    summary: ((r.preview as { summary?: unknown } | null)?.summary as string | undefined) ?? "",
    preview: r.preview,
    result: r.result,
    error: r.error,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    resolvedAt: r.resolvedAt,
  }));
}
