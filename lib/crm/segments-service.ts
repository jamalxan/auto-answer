/**
 * ETAP 5.1 — saved segments (TZ 29): CRUD per workspace, live preview and
 * the cached count. The filter DSL, its validation and the Prisma `where`
 * compilation live in ./segments (pure); this file is the DB side.
 *
 * Preview = count + first rows through the *same* `where`, so the number on
 * the segment card always equals the list a broadcast would address.
 */

import { z } from "zod";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { notFound, unprocessable } from "./errors";
import { compileSegmentWhere, describeFilter, parseSegmentFilter, segmentFilterSchema, type DescribeOptions, type SegmentFilter } from "./segments";

export const SEGMENT_NOT_FOUND = "Segment topilmadi";
export const SEGMENT_IN_USE = "Bu segment rejalashtirilgan yoki yuborilayotgan broadcastda ishlatilmoqda";
export const FILTER_INVALID = "Segment filtri noto'g'ri";

export const segmentInputSchema = z.object({
  name: z.string().trim().min(1, "Segment nomi kiritilmagan").max(80, "Segment nomi 80 belgidan oshmasin"),
  description: z.string().trim().max(500, "Tavsif 500 belgidan oshmasin").nullable().optional(),
  filter: segmentFilterSchema,
});
export type SegmentInput = z.infer<typeof segmentInputSchema>;

export const segmentUpdateSchema = segmentInputSchema.partial();
export type SegmentUpdate = z.infer<typeof segmentUpdateSchema>;

export const PREVIEW_LIMIT_MAX = 100;

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Noto'g'ri ma'lumot";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}

export interface SegmentRow {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  filter: SegmentFilter;
  lastCount: number | null;
  lastCountedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRow(row: {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  filter: unknown;
  lastCount: number | null;
  lastCountedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SegmentRow {
  return { ...row, filter: parseSegmentFilter(row.filter) ?? { v: 1, all: [] } };
}

/** workspace + compiled filter, the one `where` every reader of a segment uses. */
export function segmentWhere(workspaceId: string, filter: SegmentFilter, now = new Date()): Prisma.CrmContactWhereInput {
  return { workspaceId, mergedIntoId: null, ...(compileSegmentWhere(filter, now) as Prisma.CrmContactWhereInput) };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function listSegments(workspaceId: string): Promise<SegmentRow[]> {
  const rows = await prisma.crmSegment.findMany({ where: { workspaceId }, orderBy: { name: "asc" } });
  return rows.map(toRow);
}

export async function getSegment(workspaceId: string, segmentId: string): Promise<SegmentRow> {
  const row = await prisma.crmSegment.findFirst({ where: { id: segmentId, workspaceId } });
  if (!row) throw notFound(SEGMENT_NOT_FOUND);
  return toRow(row);
}

export async function createSegment(workspaceId: string, input: unknown, createdByUserId?: string | null): Promise<SegmentRow> {
  const parsed = segmentInputSchema.safeParse(input);
  if (!parsed.success) throw unprocessable(firstIssue(parsed.error));
  const count = await prisma.crmContact.count({ where: segmentWhere(workspaceId, parsed.data.filter) });
  const row = await prisma.crmSegment.create({
    data: {
      workspaceId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      filter: parsed.data.filter as Prisma.InputJsonValue,
      lastCount: count,
      lastCountedAt: new Date(),
      createdByUserId: createdByUserId ?? null,
    },
  });
  return toRow(row);
}

export async function updateSegment(workspaceId: string, segmentId: string, input: unknown): Promise<SegmentRow> {
  const parsed = segmentUpdateSchema.safeParse(input);
  if (!parsed.success) throw unprocessable(firstIssue(parsed.error));
  const existing = await prisma.crmSegment.findFirst({ where: { id: segmentId, workspaceId } });
  if (!existing) throw notFound(SEGMENT_NOT_FOUND);
  const data: Prisma.CrmSegmentUpdateInput = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.filter !== undefined) {
    data.filter = parsed.data.filter as Prisma.InputJsonValue;
    data.lastCount = await prisma.crmContact.count({ where: segmentWhere(workspaceId, parsed.data.filter) });
    data.lastCountedAt = new Date();
  }
  const row = await prisma.crmSegment.update({ where: { id: existing.id }, data });
  return toRow(row);
}

/** 422 while a SCHEDULED / RUNNING broadcast still points at the segment. */
export async function deleteSegment(workspaceId: string, segmentId: string): Promise<void> {
  const existing = await prisma.crmSegment.findFirst({ where: { id: segmentId, workspaceId } });
  if (!existing) throw notFound(SEGMENT_NOT_FOUND);
  const inUse = await prisma.crmBroadcast.count({
    where: { segmentId: existing.id, status: { in: ["SCHEDULED", "RUNNING"] } },
  });
  if (inUse > 0) throw unprocessable(SEGMENT_IN_USE);
  await prisma.crmSegment.delete({ where: { id: existing.id } });
}

// ─── Preview / count ──────────────────────────────────────────────────────────

export interface PreviewItem {
  id: string;
  username: string | null;
  name: string | null;
  phoneE164: string | null;
  language: string | null;
  status: string;
  temperature: string;
  score: number;
  hasAiState: boolean;
  assignedMemberId: string | null;
  lastInteractionAt: Date | null;
  tags: string[];
}

export interface SegmentPreview {
  count: number;
  items: PreviewItem[];
  limit: number;
}

/** count + the first `limit` contacts (most recent interaction first) through the same `where`. */
export async function previewSegment(
  workspaceId: string,
  filter: unknown,
  options: { limit?: number; now?: Date } = {}
): Promise<SegmentPreview> {
  const parsed = segmentFilterSchema.safeParse(filter);
  if (!parsed.success) throw unprocessable(`${FILTER_INVALID}: ${firstIssue(parsed.error)}`);
  const limit = Math.max(1, Math.min(PREVIEW_LIMIT_MAX, Math.trunc(options.limit ?? 20)));
  const where = segmentWhere(workspaceId, parsed.data, options.now ?? new Date());
  const [count, rows] = await Promise.all([
    prisma.crmContact.count({ where }),
    prisma.crmContact.findMany({
      where,
      orderBy: [{ lastInteractionAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: { tags: { include: { tag: { select: { slug: true } } } } },
    }),
  ]);
  return {
    count,
    limit,
    items: rows.map((row) => ({
      id: row.id,
      username: row.username ?? null,
      name: row.name ?? null,
      phoneE164: row.phoneE164 ?? null,
      language: row.language ?? null,
      status: row.status,
      temperature: row.temperature,
      score: row.score,
      hasAiState: row.hasAiState,
      assignedMemberId: row.assignedMemberId ?? null,
      lastInteractionAt: row.lastInteractionAt ?? null,
      tags: row.tags.map((link) => link.tag?.slug).filter((slug): slug is string => Boolean(slug)),
    })),
  };
}

/** Recounts and caches `lastCount` / `lastCountedAt`. */
export async function refreshSegmentCount(segmentId: string, now = new Date()): Promise<number> {
  const row = await prisma.crmSegment.findUnique({ where: { id: segmentId } });
  if (!row) throw notFound(SEGMENT_NOT_FOUND);
  const filter = parseSegmentFilter(row.filter);
  if (!filter) throw unprocessable(FILTER_INVALID);
  const count = await prisma.crmContact.count({ where: segmentWhere(row.workspaceId, filter, now) });
  await prisma.crmSegment.update({ where: { id: row.id }, data: { lastCount: count, lastCountedAt: now } });
  return count;
}

// ─── Describe ─────────────────────────────────────────────────────────────────

/** id → name maps for stages, pipelines, members, accounts and tags of the workspace. */
export async function loadDescribeNames(workspaceId: string): Promise<DescribeOptions> {
  const [pipelines, members, accounts, tags] = await Promise.all([
    prisma.crmPipeline.findMany({ where: { workspaceId }, select: { id: true, name: true, stages: { select: { id: true, name: true } } } }),
    prisma.workspaceMember.findMany({ where: { workspaceId }, select: { id: true, user: { select: { name: true, email: true } } } }),
    prisma.instagramAccount.findMany({ where: { workspaceId }, select: { id: true, username: true } }),
    prisma.crmTag.findMany({ where: { workspaceId }, select: { slug: true, name: true } }),
  ]);
  const stageNames: Record<string, string> = {};
  const pipelineNames: Record<string, string> = {};
  for (const pipeline of pipelines) {
    pipelineNames[pipeline.id] = pipeline.name;
    for (const stage of pipeline.stages ?? []) stageNames[stage.id] = stage.name;
  }
  return {
    stageNames,
    pipelineNames,
    memberNames: Object.fromEntries(members.map((m) => [m.id, m.user?.name || m.user?.email || m.id])),
    accountNames: Object.fromEntries(accounts.map((a) => [a.id, `@${a.username}`])),
    tagNames: Object.fromEntries(tags.map((t) => [t.slug, t.name])),
  };
}

/** The Uzbek sentence for the card, with real names in place of ids / slugs. */
export function describeSegment(segment: Pick<SegmentRow, "filter">, names: DescribeOptions): string {
  return describeFilter(segment.filter, names);
}

/** Convenience: loads the names and describes every segment of the workspace. */
export async function describeSegments(workspaceId: string, segments: Array<Pick<SegmentRow, "id" | "filter">>): Promise<Record<string, string>> {
  const names = await loadDescribeNames(workspaceId);
  return Object.fromEntries(segments.map((segment) => [segment.id, describeSegment(segment, names)]));
}
