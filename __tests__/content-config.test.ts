/**
 * Content Scheduler (ETAP 13) — env-driven limits and the kill switch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  carouselMaxItems,
  isContentSchedulerEnabled,
  latePublishMaxMs,
  maxCollaborators,
  storageQuotaBytes,
} from "@/lib/content/config";

afterEach(() => vi.unstubAllEnvs());

describe("content config", () => {
  it("carousel max defaults to 10 and clamps to 2..20", () => {
    vi.stubEnv("CAROUSEL_MAX_ITEMS", "");
    expect(carouselMaxItems()).toBe(10);
    vi.stubEnv("CAROUSEL_MAX_ITEMS", "20");
    expect(carouselMaxItems()).toBe(20);
    vi.stubEnv("CAROUSEL_MAX_ITEMS", "99");
    expect(carouselMaxItems()).toBe(20);
    vi.stubEnv("CAROUSEL_MAX_ITEMS", "abc");
    expect(carouselMaxItems()).toBe(10);
  });

  it("collaborators default to 3 and clamp to 1..5", () => {
    vi.stubEnv("IG_MAX_COLLABORATORS", "");
    expect(maxCollaborators()).toBe(3);
    vi.stubEnv("IG_MAX_COLLABORATORS", "9");
    expect(maxCollaborators()).toBe(5);
  });

  it("kill switch disables the scheduler", () => {
    vi.stubEnv("CONTENT_SCHEDULER_DISABLED", "");
    expect(isContentSchedulerEnabled()).toBe(true);
    vi.stubEnv("CONTENT_SCHEDULER_DISABLED", "1");
    expect(isContentSchedulerEnabled()).toBe(false);
  });

  it("late publish window is 15 minutes by default", () => {
    vi.stubEnv("LATE_PUBLISH_MAX_MIN", "");
    expect(latePublishMaxMs()).toBe(900_000);
    vi.stubEnv("LATE_PUBLISH_MAX_MIN", "5");
    expect(latePublishMaxMs()).toBe(300_000);
  });

  it("storage quota defaults to 5 GiB", () => {
    vi.stubEnv("CONTENT_STORAGE_QUOTA_BYTES", "");
    expect(storageQuotaBytes()).toBe(5 * 1024 ** 3);
  });
});
