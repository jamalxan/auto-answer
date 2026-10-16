/**
 * ETAP 5.0 — merged contact timeline (TZ 32).
 *
 * Messages are never copied into the CRM: the detail page reads them live
 * from the four stores (ConversationMessage, TriggerMessage, DmLog, Lead /
 * LeadDelivery) plus CrmActivity, and this module merges those lists into one
 * feed, newest first.
 *
 * The same Instagram message can sit in two stores (the trigger engine's
 * TriggerMessage and the assistant's ConversationMessage both keep `mid`).
 * With `dedupeByMid` one copy is kept: the richer one, i.e. the assistant
 * store over TriggerMessage over DmLog, then the one with more payload.
 *
 * Pure: no database.
 */

import type { CrmActivityActor, CrmActivityType, TimelineSourceTable } from "./types";

export interface TimelineItem {
  id: string;
  type: CrmActivityType;
  occurredAt: Date;
  actorKind: CrmActivityActor;
  /** One line, Uzbek ("JavobAI javobi", "Lead yaratildi"). */
  title: string;
  body?: string | null;
  /** Instagram message id, when the item is a message. */
  mid?: string | null;
  sourceTable: TimelineSourceTable;
  sourceId: string;
  payload?: Record<string, unknown> | null;
}

export interface MergeOptions {
  dedupeByMid: boolean;
}

/** Which store wins when two items carry the same `mid`. */
const SOURCE_RANK: Record<TimelineSourceTable, number> = {
  ConversationMessage: 4,
  CrmActivity: 3,
  TriggerMessage: 2,
  TriggerExecution: 1,
  TriggerFollowUpRun: 1,
  InstagramEvent: 1,
  DmLog: 1,
  Lead: 0,
  LeadDelivery: 0,
  AiHandoff: 0,
  AiScoreEvent: 0,
};

function richness(item: TimelineItem): number {
  const payloadKeys = item.payload ? Object.keys(item.payload).length : 0;
  const body = item.body ? 1 : 0;
  return SOURCE_RANK[item.sourceTable] * 1000 + payloadKeys * 2 + body;
}

/**
 * Flattens the sources, drops duplicate rows (same source + id) and, with
 * `dedupeByMid`, duplicate messages (same `mid`), then sorts newest first.
 * Stable: items with the same `occurredAt` keep their input order.
 */
export function mergeTimeline(sources: TimelineItem[][], opts: MergeOptions = { dedupeByMid: true }): TimelineItem[] {
  const byRow = new Map<string, TimelineItem>();
  for (const item of sources.flat()) {
    const key = `${item.sourceTable}:${item.sourceId}`;
    if (!byRow.has(key)) byRow.set(key, item);
  }
  let items = Array.from(byRow.values());

  if (opts.dedupeByMid) {
    const byMid = new Map<string, TimelineItem>();
    const rest: TimelineItem[] = [];
    for (const item of items) {
      if (!item.mid) {
        rest.push(item);
        continue;
      }
      const current = byMid.get(item.mid);
      if (!current || richness(item) > richness(current)) byMid.set(item.mid, item);
    }
    const kept = new Set(byMid.values());
    items = items.filter((item) => !item.mid || kept.has(item));
  }

  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.occurredAt.getTime() - a.item.occurredAt.getTime() || a.index - b.index)
    .map(({ item }) => item);
}

export interface TimelinePage {
  items: TimelineItem[];
  /** Pass back as `before` for the next page; null when this was the last one. */
  nextBefore: Date | null;
  hasMore: boolean;
}

/**
 * Keyset page over an already merged (newest-first) timeline: items strictly
 * older than `before`, at most `limit`. Items sharing one millisecond with
 * `before` are skipped on the next page, which the UI accepts over the cost
 * of a compound cursor.
 */
export function pageByTime(items: TimelineItem[], before: Date | null | undefined, limit: number): TimelinePage {
  const size = Math.max(1, Math.trunc(limit));
  const older = before ? items.filter((item) => item.occurredAt.getTime() < before.getTime()) : items;
  const page = older.slice(0, size);
  const hasMore = older.length > size;
  return { items: page, nextBefore: hasMore ? page[page.length - 1].occurredAt : null, hasMore };
}
