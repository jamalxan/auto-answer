/**
 * ETAP 13 Faza 2 — FR-S8 recurrence expansion: daily / weekdays / monthly,
 * wall-clock time in the post's zone, end date, the 180-day and 200-copy
 * limits.
 */
import { describe, expect, it } from "vitest";
import { expandRecurrence, RECURRENCE_LIMITS } from "@/lib/content/recurrence";

const TZ = "Asia/Tashkent";
const iso = (r: ReturnType<typeof expandRecurrence>) => (r.ok ? r.dates.map((d) => d.toISOString()) : r.error);

describe("expandRecurrence", () => {
  it("daily: every day at the same wall-clock time, end date inclusive", () => {
    const r = expandRecurrence({ frequency: "daily", startDate: "2026-10-24", time: "19:00", until: "2026-10-27", timezone: TZ });
    expect(iso(r)).toEqual(["2026-10-24T14:00:00.000Z", "2026-10-25T14:00:00.000Z", "2026-10-26T14:00:00.000Z", "2026-10-27T14:00:00.000Z"]);
  });

  it("daily with an interval of 2", () => {
    const r = expandRecurrence({ frequency: "daily", interval: 2, startDate: "2026-10-24", time: "09:30", until: "2026-10-30", timezone: TZ });
    expect(r.ok && r.dates.length).toBe(4);
    expect(r.ok && r.dates[1].toISOString()).toBe("2026-10-26T04:30:00.000Z");
  });

  it("weekly: only the chosen weekdays (0 = Monday), starting on the first matching day", () => {
    // 2026-10-24 is a Saturday.
    const r = expandRecurrence({ frequency: "weekly", weekdays: [0, 2], startDate: "2026-10-24", time: "10:00", until: "2026-11-04", timezone: TZ });
    expect(iso(r)).toEqual(["2026-10-26T05:00:00.000Z", "2026-10-28T05:00:00.000Z", "2026-11-02T05:00:00.000Z", "2026-11-04T05:00:00.000Z"]);
  });

  it("weekly every second week", () => {
    const r = expandRecurrence({ frequency: "weekly", interval: 2, weekdays: [0], startDate: "2026-10-26", time: "10:00", until: "2026-11-30", timezone: TZ });
    expect(r.ok && r.dates.map((d) => d.toISOString().slice(0, 10))).toEqual(["2026-10-26", "2026-11-09", "2026-11-23"]);
  });

  it("weekly without weekdays is refused", () => {
    const r = expandRecurrence({ frequency: "weekly", weekdays: [], startDate: "2026-10-24", time: "10:00", until: "2026-11-04", timezone: TZ });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/hafta kun/i);
  });

  it("monthly: same day of month, months without that day are skipped", () => {
    const r = expandRecurrence({ frequency: "monthly", startDate: "2027-01-31", time: "12:00", until: "2027-06-30", timezone: TZ });
    expect(r.ok && r.dates.map((d) => d.toISOString().slice(0, 10))).toEqual(["2027-01-31", "2027-03-31", "2027-05-31"]);
  });

  it("monthly on the 29th keeps February only in a leap year", () => {
    const r = expandRecurrence({ frequency: "monthly", startDate: "2027-12-29", time: "08:00", until: "2028-03-29", timezone: TZ });
    expect(r.ok && r.dates.map((d) => d.toISOString().slice(0, 10))).toEqual(["2027-12-29", "2028-01-29", "2028-02-29", "2028-03-29"]);
  });

  it("Tashkent has no DST: the UTC hour is the same all year", () => {
    const r = expandRecurrence({ frequency: "monthly", startDate: "2027-01-15", time: "19:00", until: "2027-06-15", timezone: TZ });
    expect(r.ok && new Set(r.dates.map((d) => d.getUTCHours()))).toEqual(new Set([14]));
  });

  it("a DST zone keeps the wall-clock time across the change", () => {
    const r = expandRecurrence({ frequency: "daily", startDate: "2026-10-24", time: "19:00", until: "2026-10-26", timezone: "Europe/Berlin" });
    // Berlin leaves summer time on 2026-10-25.
    expect(iso(r)).toEqual(["2026-10-24T17:00:00.000Z", "2026-10-25T18:00:00.000Z", "2026-10-26T18:00:00.000Z"]);
  });

  it("refuses a span over 180 days", () => {
    const r = expandRecurrence({ frequency: "monthly", startDate: "2026-10-24", time: "19:00", until: "2027-05-01", timezone: TZ });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/180 kun/);
  });

  it("accepts exactly 180 days", () => {
    const r = expandRecurrence({ frequency: "monthly", startDate: "2026-10-24", time: "19:00", until: "2027-04-22", timezone: TZ });
    expect(r.ok).toBe(true);
  });

  it("refuses more than 200 copies", () => {
    expect(RECURRENCE_LIMITS.maxCopies).toBe(200);
    // 180 days daily = 181 copies, the densest rule inside the span; the copy limit is checked with a lower cap.
    const ok = expandRecurrence({ frequency: "daily", startDate: "2026-10-24", time: "19:00", until: "2027-04-22", timezone: TZ });
    expect(ok.ok && ok.dates.length).toBe(181);
    const tooMany = expandRecurrence({ frequency: "daily", startDate: "2026-10-24", time: "19:00", until: "2027-04-22", timezone: TZ }, { maxCopies: 100 });
    expect(tooMany.ok).toBe(false);
    expect(!tooMany.ok && tooMany.error).toMatch(/100 ta/);
  });

  it("refuses an end date before the start and an empty window", () => {
    expect(expandRecurrence({ frequency: "daily", startDate: "2026-10-24", time: "19:00", until: "2026-10-23", timezone: TZ }).ok).toBe(false);
    const empty = expandRecurrence({ frequency: "weekly", weekdays: [0], startDate: "2026-10-24", time: "19:00", until: "2026-10-25", timezone: TZ });
    expect(empty.ok).toBe(false);
  });

  it("refuses bad dates, times and zones", () => {
    expect(expandRecurrence({ frequency: "daily", startDate: "2026-13-01", time: "19:00", until: "2026-12-01", timezone: TZ }).ok).toBe(false);
    expect(expandRecurrence({ frequency: "daily", startDate: "2026-10-24", time: "25:00", until: "2026-12-01", timezone: TZ }).ok).toBe(false);
    expect(expandRecurrence({ frequency: "daily", startDate: "2026-10-24", time: "19:00", until: "2026-12-01", timezone: "Mars/Base" }).ok).toBe(false);
  });
});
