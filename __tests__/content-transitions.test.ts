/**
 * ETAP 13 — the post status machine (spec §7 table). Pure.
 */
import { describe, expect, it } from "vitest";
import { POST_STATUSES } from "@/lib/content/schema";
import { canTransition, EDITABLE, TERMINAL, TRANSITIONS } from "@/lib/content/transitions";

describe("transitions", () => {
  it("follows the spec table", () => {
    expect(canTransition("SCHEDULED", "PREPARING")).toBe(true);
    expect(canTransition("PUBLISHED", "DRAFT")).toBe(false);
    expect(canTransition("FAILED", "NEEDS_MANUAL")).toBe(true);
    expect(canTransition("PUBLISHING", "DRAFT")).toBe(false);
    expect(canTransition("NEEDS_MANUAL", "PUBLISHED_MANUAL")).toBe(true);
    expect(canTransition("READY_TO_PUBLISH", "PUBLISHING")).toBe(true);
    expect(canTransition("PAUSED", "SCHEDULED")).toBe(true);
  });

  it("covers every status", () => {
    for (const status of POST_STATUSES) expect(TRANSITIONS).toHaveProperty(status);
    expect(TERMINAL).toEqual(["PUBLISHED", "PUBLISHED_MANUAL"]);
    expect(EDITABLE).not.toContain("PUBLISHING");
    expect(EDITABLE).toContain("DRAFT");
  });
});
