/**
 * ETAP 11 — persistence helpers of the migration service: row views (the
 * encrypted key never leaves this layer), idempotent item sync from a
 * ManyChat snapshot, the automatic imports (CRM tags, field and variable
 * mappings), the hourly AI call counter and the conversion context.
 *
 * Every query is scoped by the project id the service already proved belongs
 * to the workspace.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { isCrmServiceError } from "@/lib/crm/errors";
import { isUniqueViolation } from "@/lib/crm/result";
import { ensureTag } from "@/lib/crm/tags";
import { tagSlug } from "@/lib/crm/defaults";
import { MAX_ITEMS_PER_KIND, USAGE_KIND_MIGRATION } from "./config";
import { isMigrationServiceError } from "./errors";
import { buildChecklist, type Checklist, CONTACT_MIGRATION_GUIDANCE, mapBotFields, mapCustomFields, mapTags, VAR_KEY_PATTERN } from "./mapping";
import type { ConvertBotVar, ConvertCustomField } from "./converter";
import type { ManychatBotField, ManychatCustomField, ManychatFlow, ManychatGrowthTool, ManychatPageInfo, ManychatTag } from "./manychat-types";

export const ITEM_KINDS = ["TAG", "CUSTOM_FIELD", "BOT_FIELD", "FLOW", "GROWTH_TOOL"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const VANISHED_NOTE = "ManyChat'da endi topilmadi (o'chirilgan bo'lishi mumkin)";

export type ItemStatus = "PENDING" | "MAPPED" | "CONVERTED" | "IMPORTED" | "SKIPPED" | "UNSUPPORTED" | "FAILED";
export type ProjectStatus = "CONNECTED" | "ANALYZED" | "IMPORTING" | "DONE" | "FAILED";

export interface ProjectRow {
  id: string;
  workspaceId: string;
  instagramAccountId: string | null;
  source: string;
  name: string;
  status: ProjectStatus;
  apiKeyEncrypted: string | null;
  apiKeyHint: string | null;
  pageSnapshot: unknown;
  lastAnalyzedAt: Date | null;
  lastError: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemRow {
  id: string;
  projectId: string;
  kind: ItemKind;
  sourceId: string | null;
  name: string;
  folder: string | null;
  status: ItemStatus;
  mapping: unknown;
  sourceText: string | null;
  warnings: unknown;
  flowId: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const json = (value: unknown) => value as Prisma.InputJsonValue;

// ─── Views (whitelists: the encrypted key is never copied) ───────────────────

export interface ProjectView {
  id: string;
  name: string;
  source: string;
  status: ProjectStatus;
  instagramAccountId: string | null;
  /** Last 4 characters of the ManyChat key. */
  apiKeyHint: string | null;
  hasKey: boolean;
  pageSnapshot: unknown;
  lastAnalyzedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeProject(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    status: row.status,
    instagramAccountId: row.instagramAccountId ?? null,
    apiKeyHint: row.apiKeyHint ?? null,
    hasKey: Boolean(row.apiKeyEncrypted),
    pageSnapshot: row.pageSnapshot ?? null,
    lastAnalyzedAt: row.lastAnalyzedAt ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ItemView {
  id: string;
  projectId: string;
  kind: ItemKind;
  sourceId: string | null;
  name: string;
  folder: string | null;
  status: ItemStatus;
  mapping: Record<string, unknown>;
  hasText: boolean;
  textLength: number;
  textPreview: string | null;
  /** Only when `withText` (single item reads). */
  sourceText?: string | null;
  warnings: unknown[];
  flowId: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeItem(row: ItemRow, options: { withText?: boolean } = {}): ItemView {
  const text = row.sourceText ?? "";
  const view: ItemView = {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    sourceId: row.sourceId ?? null,
    name: row.name,
    folder: row.folder ?? null,
    status: row.status,
    mapping: asRecord(row.mapping),
    hasText: text.length > 0,
    textLength: text.length,
    textPreview: text ? text.slice(0, 200) : null,
    warnings: asArray(row.warnings),
    flowId: row.flowId ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (options.withText) view.sourceText = row.sourceText ?? null;
  return view;
}

export type ItemsByKind = Record<ItemKind, ItemView[]>;

export function groupItems(rows: readonly ItemRow[]): ItemsByKind {
  const grouped = Object.fromEntries(ITEM_KINDS.map((kind) => [kind, [] as ItemView[]])) as ItemsByKind;
  for (const row of rows) if (grouped[row.kind]) grouped[row.kind].push(serializeItem(row));
  return grouped;
}

export interface KindCounts {
  total: number;
  byStatus: Record<string, number>;
}

export function countItems(rows: ReadonlyArray<Pick<ItemRow, "kind" | "status">>): Record<ItemKind, KindCounts> {
  const counts = Object.fromEntries(ITEM_KINDS.map((kind) => [kind, { total: 0, byStatus: {} as Record<string, number> }])) as Record<ItemKind, KindCounts>;
  for (const row of rows) {
    const bucket = counts[row.kind];
    if (!bucket) continue;
    bucket.total += 1;
    bucket.byStatus[row.status] = (bucket.byStatus[row.status] ?? 0) + 1;
  }
  return counts;
}

export function checklistOf(project: Pick<ProjectRow, "instagramAccountId">, rows: ReadonlyArray<Pick<ItemRow, "kind" | "status">>): Checklist {
  return buildChecklist({ instagramAccountId: project.instagramAccountId, items: rows });
}

export { CONTACT_MIGRATION_GUIDANCE };

// ─── Snapshot sync ────────────────────────────────────────────────────────────

export interface ManychatSnapshot {
  info: ManychatPageInfo;
  tags: ManychatTag[];
  customFields: ManychatCustomField[];
  botFields: ManychatBotField[];
  flows: ManychatFlow[];
  growthTools: ManychatGrowthTool[];
  /** Sections ManyChat did not return (404): kept out of the "vanished" sweep. */
  missingSections: ItemKind[];
}

/** ManyChat rows without an id still get a stable key from their name. */
const sourceKey = (id: string, name: string) => id || `n:${tagSlug(name) || name.toLowerCase()}`;

export interface SyncResult {
  /** Rows dropped because the snapshot listed the same (kind, id) twice. */
  duplicates?: number;
  created: number;
  updated: number;
  vanished: number;
  restored: number;
}

export async function syncItems(workspaceId: string, projectId: string, snapshot: ManychatSnapshot): Promise<SyncResult> {
  const existing = (await prisma.migrationItem.findMany({ where: { projectId } })) as unknown as ItemRow[];
  const byKey = new Map<string, ItemRow>(existing.map((item) => [`${item.kind}|${item.sourceId ?? ""}`, item]));
  const seen = new Set<string>();
  const result: SyncResult = { created: 0, updated: 0, vanished: 0, restored: 0, duplicates: 0 };
  /** Notes for kept items whose duplicate was dropped (key `kind|id`). */
  const duplicateNotes = new Map<string, string>();
  const droppedNames = new Map<string, string[]>();
  const dedupe = <T extends { name: string }>(kind: ItemKind, list: T[], idOf: (row: T) => string): T[] => {
    const kept = new Map<string, T>();
    for (const row of list) {
      const id = idOf(row);
      if (!kept.has(id)) {
        kept.set(id, row);
        continue;
      }
      result.duplicates = (result.duplicates ?? 0) + 1;
      const key = `${kind}|${id}`;
      const names = [...(droppedNames.get(key) ?? []), `«${row.name.slice(0, 60)}»`];
      droppedNames.set(key, names);
      duplicateNotes.set(key, `Takroriy yozuv o'tkazib yuborildi: ${names.join(", ")}`);
    }
    return [...kept.values()];
  };

  const crmSlugs = (await prisma.crmTag.findMany({ where: { workspaceId }, select: { slug: true } })).map((t: { slug: string }) => t.slug);
  const usedKeys = new Set<string>();
  for (const item of existing) {
    const mapping = asRecord(item.mapping);
    if (item.kind === "CUSTOM_FIELD" && asString(mapping.key)) usedKeys.add(asString(mapping.key));
    if (item.kind === "BOT_FIELD" && asString(mapping.varKey)) usedKeys.add(asString(mapping.varKey));
  }
  const usedTagSlugs = existing.filter((i) => i.kind === "TAG").map((i) => asString(asRecord(i.mapping).targetSlug)).filter(Boolean);

  const isNew = (kind: ItemKind, id: string) => !byKey.has(`${kind}|${id}`);

  interface Draft {
    kind: ItemKind;
    id: string;
    name: string;
    folder: string | null;
    mapping: Record<string, unknown>;
    status: ItemStatus;
    note: string | null;
  }
  const drafts: Draft[] = [];

  const tags = dedupe("TAG", snapshot.tags.map((t) => ({ ...t, id: sourceKey(t.id, t.name) })), (t) => t.id).slice(0, MAX_ITEMS_PER_KIND);
  const newTags = tags.filter((t) => isNew("TAG", t.id));
  const tagMaps = mapTags(newTags, [...crmSlugs, ...usedTagSlugs]);
  newTags.forEach((tag, i) => {
    const mapped = tagMaps[i];
    drafts.push({
      kind: "TAG",
      id: tag.id,
      name: tag.name,
      folder: null,
      mapping: { targetSlug: mapped.targetSlug, action: mapped.action },
      status: mapped.action === "skip" ? "SKIPPED" : "PENDING",
      note: mapped.action === "skip" ? "Teg nomida harf yoki raqam yo'q — o'tkazib yuborildi" : null,
    });
  });

  const fields = dedupe("CUSTOM_FIELD", snapshot.customFields.map((f) => ({ ...f, id: sourceKey(f.id, f.name) })), (f) => f.id).slice(0, MAX_ITEMS_PER_KIND);
  const newFields = fields.filter((f) => isNew("CUSTOM_FIELD", f.id));
  const fieldMaps = mapCustomFields(newFields, usedKeys);
  newFields.forEach((field, i) => {
    const mapped = fieldMaps[i];
    usedKeys.add(mapped.key);
    drafts.push({
      kind: "CUSTOM_FIELD",
      id: field.id,
      name: field.name,
      folder: null,
      mapping: { key: mapped.key, type: mapped.type, note: mapped.note, manychatType: field.type, description: field.description },
      status: "PENDING",
      note: null,
    });
  });

  const bots = dedupe("BOT_FIELD", snapshot.botFields.map((f) => ({ ...f, id: sourceKey(f.id, f.name) })), (f) => f.id).slice(0, MAX_ITEMS_PER_KIND);
  const newBots = bots.filter((f) => isNew("BOT_FIELD", f.id));
  const botMaps = mapBotFields(newBots, usedKeys);
  newBots.forEach((bot, i) => {
    const mapped = botMaps[i];
    usedKeys.add(mapped.varKey);
    drafts.push({
      kind: "BOT_FIELD",
      id: bot.id,
      name: bot.name,
      folder: null,
      mapping: { varKey: mapped.varKey, value: mapped.value, hasValue: mapped.hasValue, manychatType: bot.type },
      status: "PENDING",
      note: null,
    });
  });

  const flows = dedupe("FLOW", snapshot.flows, (f) => f.ns).slice(0, MAX_ITEMS_PER_KIND);
  for (const flow of flows) {
    if (isNew("FLOW", flow.ns)) drafts.push({ kind: "FLOW", id: flow.ns, name: flow.name, folder: flow.folder, mapping: {}, status: "PENDING", note: null });
  }
  const tools = dedupe("GROWTH_TOOL", snapshot.growthTools, (t) => t.id).slice(0, MAX_ITEMS_PER_KIND);
  for (const tool of tools) {
    if (isNew("GROWTH_TOOL", tool.id)) {
      drafts.push({ kind: "GROWTH_TOOL", id: tool.id, name: tool.name, folder: null, mapping: { type: tool.type }, status: "PENDING", note: "Qoidalari API orqali berilmaydi — qo'lda qayta yarating" });
    }
  }

  for (const draft of drafts) {
    const dup = duplicateNotes.get(`${draft.kind}|${draft.id}`);
    const note = [draft.note, dup].filter(Boolean).join(" · ") || null;
    try {
      await prisma.migrationItem.create({
        data: { projectId, kind: draft.kind, sourceId: draft.id, name: draft.name.slice(0, 200), folder: draft.folder, status: draft.status, mapping: json(draft.mapping), warnings: json([]), note },
      });
      result.created += 1;
    } catch (error) {
      // One bad row (e.g. a parallel analysis created it first) never aborts the rest.
      if (!isUniqueViolation(error)) throw error;
      result.duplicates = (result.duplicates ?? 0) + 1;
    }
  }

  // Known items: refresh the ManyChat-owned fields only; mapping, status and text are the owner's.
  const seenRows: Array<{ kind: ItemKind; id: string; name: string; folder: string | null }> = [
    ...tags.map((t) => ({ kind: "TAG" as const, id: t.id, name: t.name, folder: null })),
    ...fields.map((f) => ({ kind: "CUSTOM_FIELD" as const, id: f.id, name: f.name, folder: null })),
    ...bots.map((f) => ({ kind: "BOT_FIELD" as const, id: f.id, name: f.name, folder: null })),
    ...flows.map((f) => ({ kind: "FLOW" as const, id: f.ns, name: f.name, folder: f.folder })),
    ...tools.map((t) => ({ kind: "GROWTH_TOOL" as const, id: t.id, name: t.name, folder: null })),
  ];
  for (const row of seenRows) {
    const key = `${row.kind}|${row.id}`;
    seen.add(key);
    const item = byKey.get(key);
    if (!item) continue;
    const data: Record<string, unknown> = {};
    if (item.name !== row.name.slice(0, 200)) data.name = row.name.slice(0, 200);
    if ((item.folder ?? null) !== row.folder) data.folder = row.folder;
    if (item.status === "SKIPPED" && item.note === VANISHED_NOTE) {
      data.status = item.sourceText ? "MAPPED" : "PENDING";
      data.note = null;
      result.restored += 1;
    }
    if (Object.keys(data).length > 0) {
      await prisma.migrationItem.update({ where: { id: item.id }, data });
      result.updated += 1;
    }
  }

  for (const item of existing) {
    const key = `${item.kind}|${item.sourceId ?? ""}`;
    if (seen.has(key) || snapshot.missingSections.includes(item.kind)) continue;
    if (item.status === "SKIPPED" && item.note === VANISHED_NOTE) continue;
    if (item.status === "IMPORTED") {
      // Already imported: the result stays valid, only a note is added.
      if (item.note !== VANISHED_NOTE) {
        await prisma.migrationItem.update({ where: { id: item.id }, data: { note: VANISHED_NOTE } });
        result.vanished += 1;
      }
      continue;
    }
    if (item.status === "SKIPPED") continue;
    await prisma.migrationItem.update({ where: { id: item.id }, data: { status: "SKIPPED", note: VANISHED_NOTE } });
    result.vanished += 1;
  }
  return result;
}

// ─── Automatic imports ────────────────────────────────────────────────────────

export interface TagImportResult {
  created: number;
  merged: number;
  failed: number;
}

/** Items still to import: nothing that is done, skipped or unsupported. */
const OPEN_STATUSES: ItemStatus[] = ["PENDING", "MAPPED", "FAILED"];

export async function importTagItems(workspaceId: string, projectId: string): Promise<TagImportResult> {
  const items = ((await prisma.migrationItem.findMany({ where: { projectId, kind: "TAG" } })) as unknown as ItemRow[]).filter((i) => OPEN_STATUSES.includes(i.status));
  const result: TagImportResult = { created: 0, merged: 0, failed: 0 };
  for (const item of items) {
    const slug = asString(asRecord(item.mapping).targetSlug) || tagSlug(item.name);
    try {
      const before = slug ? await prisma.crmTag.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } }) : null;
      await ensureTag(workspaceId, item.name, slug);
      if (before) result.merged += 1;
      else result.created += 1;
      await prisma.migrationItem.update({
        where: { id: item.id },
        data: { status: "IMPORTED", note: before ? "Mavjud teg bilan birlashtirildi" : "CRM tegi yaratildi", mapping: json({ ...asRecord(item.mapping), targetSlug: slug, action: before ? "merge" : "create" }) },
      });
    } catch (error) {
      result.failed += 1;
      await prisma.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", note: isMigrationServiceError(error) || isCrmServiceError(error) ? error.message.slice(0, 200) : "Tegni yaratib bo'lmadi" } });
    }
  }
  return result;
}

export interface FieldImportResult {
  imported: number;
  failed: number;
}

/** Fields and variables need no table: the mapping on the item IS the import. Keys are re-validated and kept unique. */
export async function importFieldItems(projectId: string, kind: "CUSTOM_FIELD" | "BOT_FIELD"): Promise<FieldImportResult> {
  const all = (await prisma.migrationItem.findMany({ where: { projectId } })) as unknown as ItemRow[];
  const keyField = kind === "CUSTOM_FIELD" ? "key" : "varKey";
  const taken = new Set<string>();
  for (const item of all) {
    if ((item.kind === "CUSTOM_FIELD" || item.kind === "BOT_FIELD") && item.status === "IMPORTED") {
      const m = asRecord(item.mapping);
      taken.add(asString(item.kind === "CUSTOM_FIELD" ? m.key : m.varKey));
    }
  }
  const result: FieldImportResult = { imported: 0, failed: 0 };
  for (const item of all.filter((i) => i.kind === kind && OPEN_STATUSES.includes(i.status))) {
    const key = asString(asRecord(item.mapping)[keyField]);
    if (!VAR_KEY_PATTERN.test(key) || taken.has(key)) {
      result.failed += 1;
      await prisma.migrationItem.update({ where: { id: item.id }, data: { status: "FAILED", note: `Kalit «${key || "—"}» yaroqsiz yoki band — boshqa kalit tanlang` } });
      continue;
    }
    taken.add(key);
    result.imported += 1;
    await prisma.migrationItem.update({
      where: { id: item.id },
      data: { status: "IMPORTED", note: kind === "CUSTOM_FIELD" ? `contact.customFields.${key} va vars.${key}` : `vars.${key} (boshlang'ich qiymat bilan)` },
    });
  }
  return result;
}

/** DONE when every importable item is imported / skipped; IMPORTING after the first import. */
export async function refreshProjectStatus(projectId: string): Promise<ProjectStatus> {
  const rows = (await prisma.migrationItem.findMany({ where: { projectId } })) as unknown as ItemRow[];
  const importable = rows.filter((r) => r.kind !== "GROWTH_TOOL");
  const finished = (r: ItemRow) => r.status === "IMPORTED" || r.status === "SKIPPED" || r.status === "UNSUPPORTED";
  const status: ProjectStatus = importable.length > 0 && importable.every(finished) ? "DONE" : rows.some((r) => r.status === "IMPORTED") ? "IMPORTING" : "ANALYZED";
  await prisma.migrationProject.update({ where: { id: projectId }, data: { status } });
  return status;
}

// ─── AI usage + conversion context ────────────────────────────────────────────

/** Migration LLM rows (conversions and screenshot reads) of this workspace in the last 60 minutes. */
export async function migrationCallsInLastHour(workspaceId: string, now: Date = new Date()): Promise<number> {
  return prisma.llmUsage.count({ where: { workspaceId, kind: USAGE_KIND_MIGRATION, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
}

export interface ConversionContext {
  customFields: ConvertCustomField[];
  botVars: ConvertBotVar[];
  tags: string[];
}

export async function loadConversionContext(projectId: string): Promise<ConversionContext> {
  const rows = ((await prisma.migrationItem.findMany({ where: { projectId } })) as unknown as ItemRow[]).filter((r) => r.status !== "SKIPPED" && r.status !== "FAILED");
  const customFields: ConvertCustomField[] = [];
  const botVars: ConvertBotVar[] = [];
  const tags: string[] = [];
  for (const row of rows) {
    const m = asRecord(row.mapping);
    if (row.kind === "CUSTOM_FIELD" && VAR_KEY_PATTERN.test(asString(m.key))) {
      const type = ["string", "number", "boolean", "date", "list"].includes(asString(m.type)) ? (asString(m.type) as ConvertCustomField["type"]) : "string";
      customFields.push({ key: asString(m.key), type, name: row.name, sourceId: row.sourceId });
    } else if (row.kind === "BOT_FIELD" && VAR_KEY_PATTERN.test(asString(m.varKey))) {
      botVars.push({ varKey: asString(m.varKey), value: asString(m.value), name: row.name });
    } else if (row.kind === "TAG" && row.status === "IMPORTED" && asString(m.targetSlug)) {
      tags.push(asString(m.targetSlug));
    }
  }
  return { customFields, botVars, tags };
}
