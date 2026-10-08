import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
let broken = false;
const redis = {
  get: vi.fn(async (key: string) => {
    if (broken) throw new Error("redis down");
    return store.get(key) ?? null;
  }),
  set: vi.fn(async (key: string, value: string) => {
    if (broken) throw new Error("redis down");
    store.set(key, value);
    return "OK";
  }),
  del: vi.fn(async (key: string) => {
    if (broken) throw new Error("redis down");
    return store.delete(key) ? 1 : 0;
  }),
};
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => redis }));

import { cachedConversationList, invalidateConversationList } from "../lib/meta/conversation-cache";

beforeEach(() => {
  store.clear();
  broken = false;
  vi.clearAllMocks();
});

describe("conversation list cache", () => {
  it("asks Meta once, then serves the cached list until a DM invalidates it", async () => {
    const load = vi.fn(async () => [{ id: "t1" }]);
    expect(await cachedConversationList("ig1", load)).toEqual([{ id: "t1" }]);
    expect(await cachedConversationList("ig1", load)).toEqual([{ id: "t1" }]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith("ig:conv-list:ig1", JSON.stringify([{ id: "t1" }]), "EX", 60);

    await invalidateConversationList("ig1");
    await cachedConversationList("ig1", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps accounts apart", async () => {
    await cachedConversationList("ig1", async () => ["a"]);
    expect(await cachedConversationList("ig2", async () => ["b"])).toEqual(["b"]);
  });

  it("falls back to Meta when Redis is down", async () => {
    broken = true;
    const load = vi.fn(async () => ["fresh"]);
    expect(await cachedConversationList("ig1", load)).toEqual(["fresh"]);
    await expect(invalidateConversationList("ig1")).resolves.toBeUndefined();
  });
});
