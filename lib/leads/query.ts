import type { Prisma } from "@/app/generated/prisma/client";

export interface LeadFilters {
  status?: string | null;
  source?: string | null;
  account?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
}

const STATUSES = new Set(["NEW", "SENT", "PARTIAL", "FAILED"]);
const SOURCES = new Set(["CAMPAIGN", "INBOUND_DM"]);

function parseDate(value: string | null | undefined, endOfDay = false): Date | null {
  if (!value) return null;
  const date = new Date(value.length === 10 ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Workspace-scoped lead filter shared by the list and CSV export. */
export function buildLeadWhere(workspaceId: string, f: LeadFilters): Prisma.LeadWhereInput {
  const where: Prisma.LeadWhereInput = { workspaceId };
  const status = f.status?.toUpperCase();
  if (status && STATUSES.has(status)) where.status = status as never;
  const source = f.source?.toUpperCase();
  if (source && SOURCES.has(source)) where.source = source as never;
  if (f.account && f.account !== "all") where.instagramAccountId = f.account;

  const from = parseDate(f.from);
  const to = parseDate(f.to, true);
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

  const q = f.q?.trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { igUsername: { contains: q.replace(/^@/, ""), mode: "insensitive" } },
      { productInterest: { contains: q, mode: "insensitive" } },
      ...(digits.length >= 3 ? [{ phoneE164: { contains: digits } }] : []),
    ];
  }
  return where;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet formula injection from customer-supplied text.
  const safe = /^[=+\-@]/.test(text) && !/^\+\d+$/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function leadsToCsv(
  leads: Array<{
    createdAt: Date;
    name: string | null;
    phoneE164: string | null;
    igUsername: string | null;
    productInterest: string | null;
    source: string;
    campaignName: string | null;
    status: string;
    flag: string | null;
    isRepeat: boolean;
    summary: string | null;
  }>
): string {
  const header = ["date", "name", "phone", "instagram", "interest", "source", "campaign", "status", "flag", "repeat", "summary"];
  const rows = leads.map((l) => [
    l.createdAt.toISOString(),
    l.name,
    l.phoneE164,
    l.igUsername ? `@${l.igUsername}` : "",
    l.productInterest,
    l.source,
    l.campaignName,
    l.status,
    l.flag,
    l.isRepeat ? "yes" : "",
    l.summary,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}
