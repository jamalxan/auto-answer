/**
 * ETAP 13 — Asia/Tashkent ↔ UTC conversion without a date library (FR-S1).
 */
import { describe, expect, it } from "vitest";
import { isValidTimeZone, utcToZoned, zonedToUtc } from "@/lib/content/time";

describe("zonedToUtc / utcToZoned", () => {
  it("converts a Tashkent wall time to UTC (+5)", () => {
    expect(zonedToUtc("2026-10-24", "19:00", "Asia/Tashkent").toISOString()).toBe("2026-10-24T14:00:00.000Z");
  });

  it("handles a DST zone", () => {
    expect(zonedToUtc("2026-07-01", "12:00", "Europe/Berlin").toISOString()).toBe("2026-07-01T10:00:00.000Z");
    expect(zonedToUtc("2026-01-01", "12:00", "Europe/Berlin").toISOString()).toBe("2026-01-01T11:00:00.000Z");
  });

  it("round-trips through utcToZoned", () => {
    const utc = zonedToUtc("2026-10-24", "19:00", "Asia/Tashkent");
    expect(utcToZoned(utc, "Asia/Tashkent")).toEqual({ date: "2026-10-24", time: "19:00" });
    expect(utcToZoned(new Date("2026-10-24T22:30:00Z"), "Asia/Tashkent")).toEqual({ date: "2026-10-25", time: "03:30" });
  });

  it("validates time zone names", () => {
    expect(isValidTimeZone("Asia/Tashkent")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
