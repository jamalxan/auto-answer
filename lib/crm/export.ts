/**
 * ETAP 5.1 — CSV export of contacts (TZ 29, permission `export_data`).
 *
 * Takes the same Prisma `where` the list / segment preview use, so "export
 * this segment" is exactly the rows the preview counted. Cells go through
 * lib/leads/query.ts `csvCell`: quoting plus the formula-injection guard for
 * customer-supplied text (names, usernames, tags). Capped at EXPORT_MAX_ROWS.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { csvCell } from "@/lib/leads/query";
import { CONTACT_SOURCE_LABELS, CONTACT_STATUS_LABELS, TEMPERATURE_LABELS } from "./types";

export const EXPORT_MAX_ROWS = 10_000;

export const EXPORT_COLUMNS = [
  "username",
  "name",
  "phone",
  "email",
  "language",
  "status",
  "temperature",
  "score",
  "tags",
  "assigned",
  "source",
  "firstInteraction",
  "lastInteraction",
] as const;

function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : "";
}

function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

/**
 * CSV (UTF-8, "\n" rows) of the workspace contacts matching `where`
 * (workspace scoping is added here; pass the compiled segment filter or {}).
 */
export async function exportContactsCsv(workspaceId: string, where: Prisma.CrmContactWhereInput = {}): Promise<string> {
  const [rows, members] = await Promise.all([
    prisma.crmContact.findMany({
      where: { ...where, workspaceId },
      orderBy: { createdAt: "asc" },
      take: EXPORT_MAX_ROWS,
      include: { tags: { include: { tag: { select: { name: true } } } } },
    }),
    prisma.workspaceMember.findMany({ where: { workspaceId }, select: { id: true, user: { select: { name: true, email: true } } } }),
  ]);
  const memberName = new Map(members.map((m) => [m.id, m.user?.name || m.user?.email || m.id]));

  const lines = rows.map((row) => [
    row.username ?? "",
    row.name ?? "",
    row.phoneE164 ?? "",
    row.email ?? "",
    row.language ?? "",
    label(CONTACT_STATUS_LABELS, row.status),
    row.hasAiState ? label(TEMPERATURE_LABELS, row.temperature) : "",
    row.hasAiState ? String(row.score) : "",
    row.tags
      .map((link) => link.tag?.name)
      .filter(Boolean)
      .join("; "),
    row.assignedMemberId ? (memberName.get(row.assignedMemberId) ?? row.assignedMemberId) : "",
    label(CONTACT_SOURCE_LABELS, row.source),
    iso(row.firstInteractionAt),
    iso(row.lastInteractionAt),
  ]);

  return [[...EXPORT_COLUMNS], ...lines].map((cells) => cells.map(csvCell).join(",")).join("\n");
}
