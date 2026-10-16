/**
 * ETAP 5.0 — merged contact timeline: ordering, dedupe by mid, paging.
 * Pure functions only.
 */

import { describe, expect, it } from "vitest";
import { mergeTimeline, pageByTime, type TimelineItem } from "../lib/crm/timeline-merge";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 16, 12, minutes));

function item(overrides: Partial<TimelineItem> & { id: string; occurredAt: Date }): TimelineItem {
  return {
    type: "MESSAGE_IN",
    actorKind: "CUSTOMER",
    title: "Kiruvchi xabar",
    sourceTable: "ConversationMessage",
    sourceId: overrides.id,
    ...overrides,
  };
}

describe("mergeTimeline", () => {
  it("merges the stores newest first (comment → reply → DM → AI reply → lead → delivery)", () => {
    const triggers = [
      item({ id: "c1", type: "COMMENT", occurredAt: at(0), sourceTable: "InstagramEvent", title: "Izoh" }),
      item({ id: "r1", type: "COMMENT_REPLY", occurredAt: at(1), sourceTable: "TriggerMessage", actorKind: "AUTOMATION", title: "Izohga javob" }),
      item({ id: "d1", type: "MESSAGE_OUT", occurredAt: at(2), sourceTable: "TriggerMessage", actorKind: "AUTOMATION", title: "DM", mid: "m-dm" }),
    ];
    const assistant = [item({ id: "ai1", type: "AI_REPLY", occurredAt: at(3), actorKind: "ASSISTANT", title: "JavobAI javobi", mid: "m-ai" })];
    const leads = [
      item({ id: "l1", type: "LEAD_CREATED", occurredAt: at(4), sourceTable: "Lead", actorKind: "SYSTEM", title: "Lead yaratildi" }),
      item({ id: "ld1", type: "LEAD_DELIVERED", occurredAt: at(5), sourceTable: "LeadDelivery", actorKind: "SYSTEM", title: "Lead yetkazildi" }),
    ];
    const merged = mergeTimeline([leads, triggers, assistant]);
    expect(merged.map((i) => i.id)).toEqual(["ld1", "l1", "ai1", "d1", "r1", "c1"]);
  });

  it("is stable for items with the same occurredAt", () => {
    const same = at(10);
    const merged = mergeTimeline([
      [item({ id: "x", occurredAt: same }), item({ id: "y", occurredAt: same })],
      [item({ id: "z", occurredAt: same }), item({ id: "w", occurredAt: at(11) })],
    ]);
    expect(merged.map((i) => i.id)).toEqual(["w", "x", "y", "z"]);
  });

  it("dedupes the same message across stores, keeping the assistant copy", () => {
    const trigger = item({ id: "tm1", occurredAt: at(2), sourceTable: "TriggerMessage", mid: "mid.1", body: "Salom" });
    const assistant = item({ id: "cm1", occurredAt: at(2), sourceTable: "ConversationMessage", mid: "mid.1", body: "Salom" });
    const merged = mergeTimeline([[trigger], [assistant]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceTable).toBe("ConversationMessage");
    // Order of sources does not change the winner.
    expect(mergeTimeline([[assistant], [trigger]])[0].id).toBe("cm1");
  });

  it("prefers the richer payload when the stores rank equally", () => {
    const thin = item({ id: "a", occurredAt: at(2), sourceTable: "TriggerMessage", mid: "mid.2" });
    const rich = item({ id: "b", occurredAt: at(2), sourceTable: "TriggerMessage", mid: "mid.2", body: "text", payload: { executionId: "e1", campaign: "x" } });
    expect(mergeTimeline([[thin], [rich]])[0].id).toBe("b");
    expect(mergeTimeline([[rich], [thin]])[0].id).toBe("b");
    // Equal richness → first seen wins.
    const twin = item({ id: "c", occurredAt: at(2), sourceTable: "TriggerMessage", mid: "mid.2" });
    expect(mergeTimeline([[thin], [twin]])[0].id).toBe("a");
  });

  it("keeps duplicates when dedupeByMid is off, and never dedupes items without a mid", () => {
    const a = item({ id: "a", occurredAt: at(2), sourceTable: "TriggerMessage", mid: "mid.3" });
    const b = item({ id: "b", occurredAt: at(2), mid: "mid.3" });
    expect(mergeTimeline([[a], [b]], { dedupeByMid: false })).toHaveLength(2);
    const n1 = item({ id: "n1", occurredAt: at(2), type: "NOTE", sourceTable: "CrmActivity" });
    const n2 = item({ id: "n2", occurredAt: at(2), type: "NOTE", sourceTable: "CrmActivity" });
    expect(mergeTimeline([[n1], [n2]])).toHaveLength(2);
  });

  it("drops the same row read twice (same source table + id)", () => {
    const row = item({ id: "cm1", occurredAt: at(1) });
    expect(mergeTimeline([[row], [{ ...row }]])).toHaveLength(1);
  });

  it("returns an empty list for no sources", () => {
    expect(mergeTimeline([])).toEqual([]);
    expect(mergeTimeline([[], []])).toEqual([]);
  });
});

describe("pageByTime", () => {
  const items = mergeTimeline([[0, 1, 2, 3, 4].map((m) => item({ id: `i${m}`, occurredAt: at(m) }))]);

  it("pages newest first with a `before` cursor", () => {
    const first = pageByTime(items, null, 2);
    expect(first.items.map((i) => i.id)).toEqual(["i4", "i3"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toEqual(at(3));

    const second = pageByTime(items, first.nextBefore, 2);
    expect(second.items.map((i) => i.id)).toEqual(["i2", "i1"]);
    expect(second.hasMore).toBe(true);

    const last = pageByTime(items, second.nextBefore, 2);
    expect(last.items.map((i) => i.id)).toEqual(["i0"]);
    expect(last.hasMore).toBe(false);
    expect(last.nextBefore).toBeNull();
  });

  it("an exact fit is the last page", () => {
    const page = pageByTime(items, null, 5);
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextBefore).toBeNull();
  });

  it("clamps the limit to at least one", () => {
    expect(pageByTime(items, null, 0).items).toHaveLength(1);
    expect(pageByTime(items, undefined, -3).items).toHaveLength(1);
  });

  it("handles an empty timeline", () => {
    expect(pageByTime([], null, 10)).toEqual({ items: [], nextBefore: null, hasMore: false });
  });
});
