/**
 * ETAP 11 — ManyChat client: fixed base URL, Bearer key, tolerant parsing,
 * error classes (401 / 429 / 5xx retries / network / timeout), the key never
 * shows up in an error, and the 8 req/s throttle.
 */

import { describe, expect, it, vi } from "vitest";
import { createManychatClient, MANYCHAT_BASE_URL, MANYCHAT_MIN_INTERVAL_MS, ManychatError } from "../lib/migration/manychat-client";

const KEY = "12345:abcdefSECRETkey";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data }), { status: 200 });
const sleeps: number[] = [];
const options = (impl: typeof fetch, apiKey = KEY) => {
  let t = 0;
  return {
    apiKey,
    fetchImpl: impl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
  };
};

describe("ManyChat client", () => {
  it("calls the fixed base URL with a Bearer key and parses tags (extra fields ignored)", async () => {
    const f = fakeFetch([ok([{ id: 7, name: "VIP", extra: { x: 1 } }, { id: "8", name: "  " }])]);
    const tags = await createManychatClient(options(f.impl)).getTags();
    expect(tags).toEqual([{ id: "7", name: "VIP" }]);
    expect(f.calls[0].url).toBe(`${MANYCHAT_BASE_URL}/fb/page/getTags`);
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(f.calls[0].init.method).toBe("GET");
    expect(f.calls[0].init.redirect).toBe("error");
  });

  it("parses page info, custom fields, bot fields, flows with folders and growth tools; every field optional", async () => {
    const f = fakeFetch([
      ok({ id: "p1", name: "Mebel", unexpected: true }),
      ok([{ id: 1, name: "Telefon", type: "Text" }, { name: "Yosh", type: "number", description: "d" }]),
      ok([{ id: 3, name: "Narx", type: "text", value: 120000 }, { id: 4, name: "Bo'sh" }]),
      ok({ flows: [{ ns: "content1", name: "Salom", folder_id: "9" }, { name: "ns yo'q" }], folders: [{ id: 9, name: "Asosiy" }] }),
      ok({ growth_tools: [{ id: 5, name: "Komment", type: "ig_comments" }] }),
    ]);
    const client = createManychatClient(options(f.impl));
    expect(await client.getInfo()).toMatchObject({ id: "p1", name: "Mebel", username: null });
    const fields = await client.getCustomFields();
    expect(fields.map((x) => [x.name, x.type])).toEqual([["Telefon", "text"], ["Yosh", "number"]]);
    const bots = await client.getBotFields();
    expect(bots[0]).toMatchObject({ name: "Narx", value: "120000" });
    expect(bots[1].value).toBeNull();
    expect(await client.getFlows()).toEqual([{ ns: "content1", name: "Salom", folder: "Asosiy" }]);
    expect(await client.getGrowthTools()).toEqual([{ id: "5", name: "Komment", type: "ig_comments" }]);
  });

  it("401 and 403 give the Uzbek invalid-key message and never leak the key", async () => {
    for (const status of [401, 403]) {
      const f = fakeFetch([new Response(`{"error":"bad token ${KEY}"}`, { status })]);
      const error = (await createManychatClient(options(f.impl)).getTags().catch((e) => e)) as ManychatError;
      expect(error).toBeInstanceOf(ManychatError);
      expect(error.kind).toBe("auth");
      expect(error.message).toMatch(/API kaliti/);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("SECRET");
    }
  });

  it("200 with status error and a token message is an auth error", async () => {
    const f = fakeFetch([new Response(JSON.stringify({ status: "error", message: "Invalid token" }), { status: 200 })]);
    const error = (await createManychatClient(options(f.impl)).getTags().catch((e) => e)) as ManychatError;
    expect(error.kind).toBe("auth");
  });

  it("429 waits for a short Retry-After once, then succeeds; a long one fails with retryAfterSec", async () => {
    const retry = fakeFetch([new Response("{}", { status: 429, headers: { "retry-after": "2" } }), ok([{ id: 1, name: "a" }])]);
    sleeps.length = 0;
    expect(await createManychatClient(options(retry.impl)).getTags()).toHaveLength(1);
    expect(sleeps).toContain(2000);

    const long = fakeFetch([new Response("{}", { status: 429, headers: { "retry-after": "60" } })]);
    const error = (await createManychatClient(options(long.impl)).getTags().catch((e) => e)) as ManychatError;
    expect(error.kind).toBe("rate_limit");
    expect(error.retryAfterSec).toBe(60);
    expect(long.calls).toHaveLength(1);
  });

  it("5xx is retried twice, then reported", async () => {
    const recovers = fakeFetch([new Response("x", { status: 502 }), new Response("x", { status: 503 }), ok([{ id: 1, name: "t" }])]);
    expect(await createManychatClient(options(recovers.impl)).getTags()).toHaveLength(1);
    expect(recovers.calls).toHaveLength(3);

    const dead = fakeFetch([500, 500, 500, 500].map((s) => new Response("x", { status: s })));
    const error = (await createManychatClient(options(dead.impl)).getTags().catch((e) => e)) as ManychatError;
    expect(error.kind).toBe("server");
    expect(dead.calls).toHaveLength(3);
  });

  it("network failures and timeouts are classified without exposing the cause", async () => {
    const net = fakeFetch([new TypeError(`fetch failed for ${KEY}`)]);
    const netError = (await createManychatClient(options(net.impl)).getTags().catch((e) => e)) as ManychatError;
    expect(netError.kind).toBe("network");
    expect(netError.message).not.toContain(KEY);

    const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    const slow = fakeFetch([timeout]);
    expect(((await createManychatClient(options(slow.impl)).getTags().catch((e) => e)) as ManychatError).kind).toBe("timeout");
  });

  it("404 is not_found; non-JSON is bad_response", async () => {
    expect(((await createManychatClient(options(fakeFetch([new Response("{}", { status: 404 })]).impl)).getGrowthTools().catch((e) => e)) as ManychatError).kind).toBe("not_found");
    expect(((await createManychatClient(options(fakeFetch([new Response("<html>", { status: 200 })]).impl)).getTags().catch((e) => e)) as ManychatError).kind).toBe("bad_response");
  });

  it("the base URL stays fixed even if the key looks like a URL; unusable keys are refused before any request", async () => {
    const f = fakeFetch([ok([])]);
    await createManychatClient(options(f.impl, "https://evil.example/steal?x=1")).getTags();
    expect(f.calls[0].url).toBe(`${MANYCHAT_BASE_URL}/fb/page/getTags`);
    expect(() => createManychatClient(options(f.impl, "bad key\r\nX-Evil: 1"))).toThrow(ManychatError);
    expect(() => createManychatClient(options(f.impl, "short"))).toThrow(ManychatError);
  });

  it("throttles to 8 requests per second", async () => {
    const f = fakeFetch([ok([]), ok([]), ok([])]);
    sleeps.length = 0;
    const client = createManychatClient(options(f.impl));
    await client.getTags();
    await client.getCustomFields();
    await client.getBotFields();
    // the first call is free, the next two each wait one interval
    expect(sleeps.filter((ms) => ms === MANYCHAT_MIN_INTERVAL_MS)).toHaveLength(2);
    expect(1000 / MANYCHAT_MIN_INTERVAL_MS).toBe(8);
  });
});
