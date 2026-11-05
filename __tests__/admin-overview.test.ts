import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { dayKeys } from "@/lib/admin/overview";
import { changePct } from "@/components/admin/parts";

describe("admin overview helpers", () => {
  it("dayKeys lists the last N days in Tashkent time, oldest first", () => {
    // 2026-11-05 20:30 UTC is already 2026-11-06 01:30 in Tashkent.
    const keys = dayKeys(new Date("2026-11-05T20:30:00Z"), 3);
    expect(keys).toEqual(["2026-11-04", "2026-11-05", "2026-11-06"]);
  });

  it("changePct compares with the previous period, null when there was nothing", () => {
    expect(changePct({ current: 15, previous: 10 })).toBe(50);
    expect(changePct({ current: 5, previous: 10 })).toBe(-50);
    expect(changePct({ current: 7, previous: 0 })).toBeNull();
  });
});
