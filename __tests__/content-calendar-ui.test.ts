/**
 * ETAP 13 Faza 2 (WP-D) — pure calendar helpers: drop targets (FR-S6),
 * bulk summary (FR-V4), best-time chips and heat map (FR-S7).
 */
import { describe, expect, it } from "vitest";
import { bestTimeLabel, bulkSummary, canMovePost, dropInstant, fromLocalInput, heatClass, nextOccurrence, toLocalInput } from "@/components/developer/content/shared";

const TZ = "Asia/Tashkent";

describe("drag-and-drop targets", () => {
  it("only SCHEDULED (schedule) and DRAFT (create) cards move", () => {
    const manager = { canCreate: true, canSchedule: true };
    const operator = { canCreate: true, canSchedule: false };
    expect(canMovePost("SCHEDULED", manager)).toBe(true);
    expect(canMovePost("SCHEDULED", operator)).toBe(false);
    expect(canMovePost("DRAFT", operator)).toBe(true);
    expect(canMovePost("DRAFT", { canCreate: false, canSchedule: false })).toBe(false);
    for (const s of ["PUBLISHED", "PUBLISHING", "PAUSED", "PENDING_REVIEW", "FAILED"] as const) expect(canMovePost(s, manager)).toBe(false);
  });

  it("a month drop keeps the time of day; a week drop takes the hour and keeps the minutes", () => {
    const at = "2026-11-03T14:25:00.000Z"; // 19:25 Tashkent
    expect(dropInstant(at, "2026-11-06", null, TZ).toISOString()).toBe("2026-11-06T14:25:00.000Z");
    expect(dropInstant(at, "2026-11-06", 9, TZ).toISOString()).toBe("2026-11-06T04:25:00.000Z");
  });

  it("a draft without a time lands at 19:00 (month) or on the hour (week)", () => {
    expect(dropInstant(null, "2026-11-06", null, TZ).toISOString()).toBe("2026-11-06T14:00:00.000Z");
    expect(dropInstant(null, "2026-11-06", 8, TZ).toISOString()).toBe("2026-11-06T03:00:00.000Z");
  });

  it("the Ko'chirish input round-trips in the zone", () => {
    expect(toLocalInput("2026-11-03T14:25:00.000Z", TZ)).toBe("2026-11-03T19:25");
    expect(fromLocalInput("2026-11-03T19:25", TZ)?.toISOString()).toBe("2026-11-03T14:25:00.000Z");
    expect(fromLocalInput("", TZ)).toBeNull();
  });
});

describe("bulk summary", () => {
  it("counts done and failed", () => {
    expect(bulkSummary({ action: "shift", done: 3, failed: 1 })).toBe("3 ta post surildi · 1 ta xato");
    expect(bulkSummary({ action: "delete", done: 2, failed: 0 })).toBe("2 ta post o'chirildi");
  });
});

describe("best times in the UI", () => {
  it("labels a cell like the spec (\"Ju 19:00\")", () => {
    expect(bestTimeLabel({ weekday: 4, hour: 19 })).toBe("Ju 19:00");
    expect(bestTimeLabel({ weekday: 0, hour: 8 })).toBe("Du 08:00");
  });

  it("a chip picks the next such weekday and hour at least five minutes ahead", () => {
    const now = new Date("2026-10-23T13:58:00.000Z"); // Friday 18:58 Tashkent
    expect(nextOccurrence(4, 19, TZ, now)).toEqual({ date: "2026-10-30", time: "19:00" }); // 19:00 today is < 5 min away
    expect(nextOccurrence(4, 21, TZ, now)).toEqual({ date: "2026-10-23", time: "21:00" });
    expect(nextOccurrence(0, 9, TZ, now)).toEqual({ date: "2026-10-26", time: "09:00" });
  });

  it("heat classes grow with the score", () => {
    expect(heatClass(0)).toBe("");
    expect(heatClass(undefined)).toBe("");
    expect(heatClass(1)).toBe("bg-accent/25");
    expect(heatClass(0.2)).toBe("bg-accent/5");
  });
});
