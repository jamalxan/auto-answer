/**
 * ETAP 13 — the content-publish queue against BullMQ's real add-job rule:
 * a job id that still exists in ANY state (delayed, active, completed,
 * failed) is not re-added — the Lua script returns the old job and only
 * emits "duplicated". Every "re-queue" path of the pipeline (sweeper,
 * quota reschedule, late prepare, lock miss) depends on the queue layer
 * clearing finished jobs out of the way first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Job = { id: string; name: string; data: unknown; opts: Record<string, unknown>; state: string };
  const state = {
    jobs: new Map<string, Job>(),
    adds: [] as string[],
    removes: [] as string[],
    lastOpts: {} as Record<string, unknown>,
  };
  class Queue {
    constructor(_name: string, opts: Record<string, unknown>) {
      state.lastOpts = opts;
    }
    async add(name: string, data: unknown, opts: { jobId: string; delay?: number }) {
      const existing = state.jobs.get(opts.jobId);
      if (existing) return existing; // BullMQ: handleDuplicatedJob — nothing is scheduled
      const job: Job = { id: opts.jobId, name, data, opts, state: opts.delay ? "delayed" : "waiting" };
      state.jobs.set(opts.jobId, job);
      state.adds.push(opts.jobId);
      return job;
    }
    async getJob(id: string) {
      const job = state.jobs.get(id);
      if (!job) return null;
      return {
        ...job,
        getState: async () => job.state,
        remove: async () => {
          state.jobs.delete(id);
          state.removes.push(id);
        },
      };
    }
  }
  return { state, Queue };
});

vi.mock("bullmq", () => ({ Queue: fake.Queue }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import { getContentPublishQueue, publishJobId, scheduleLockRetry, schedulePublish } from "@/lib/content/queue";

const NOW = new Date("2026-10-24T14:00:00Z");

beforeEach(() => {
  vi.stubEnv("REDIS_URL", "redis://localhost:6381");
  vi.stubEnv("CONTENT_SCHEDULER_DISABLED", "");
  fake.state.jobs.clear();
  fake.state.adds.length = 0;
  fake.state.removes.length = 0;
});

describe("content-publish queue", () => {
  it("drops finished jobs at once — their history is PublishAttempt, and a kept id blocks every re-queue", () => {
    getContentPublishQueue();
    expect(fake.state.lastOpts.defaultJobOptions).toMatchObject({ removeOnComplete: true, removeOnFail: true });
  });

  it("re-scheduling an id whose job already completed replaces it", async () => {
    await schedulePublish("p1", 1, NOW);
    expect(fake.state.adds).toEqual([publishJobId("p1", 1)]);
    fake.state.jobs.get(publishJobId("p1", 1))!.state = "completed";
    await schedulePublish("p1", 1, NOW);
    expect(fake.state.removes).toEqual([publishJobId("p1", 1)]);
    expect(fake.state.adds).toHaveLength(2);
  });

  it("re-scheduling an id whose job failed replaces it too", async () => {
    await schedulePublish("p1", 1, NOW);
    fake.state.jobs.get(publishJobId("p1", 1))!.state = "failed";
    await schedulePublish("p1", 1, NOW);
    expect(fake.state.adds).toHaveLength(2);
  });

  it("re-scheduling an id whose job is still delayed or active is a no-op", async () => {
    await schedulePublish("p1", 1, NOW);
    await schedulePublish("p1", 1, NOW);
    fake.state.jobs.get(publishJobId("p1", 1))!.state = "active";
    await schedulePublish("p1", 1, NOW);
    expect(fake.state.adds).toHaveLength(1);
    expect(fake.state.removes).toHaveLength(0);
  });

  it("a lock-miss retry gets a fresh id every time and keeps the pipeline's retry counter", async () => {
    await scheduleLockRetry("p1", 1, 2, 15_000);
    await scheduleLockRetry("p1", 1, 2, 15_000);
    expect(fake.state.adds).toHaveLength(2);
    expect(new Set(fake.state.adds).size).toBe(2);
    for (const id of fake.state.adds) expect(fake.state.jobs.get(id)!.data).toMatchObject({ postId: "p1", attempt: 1, retryNo: 2 });
  });
});
