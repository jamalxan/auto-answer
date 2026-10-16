/** ETAP 8 webhook connector: request shape, response classifier matrix, fake-fetch executor. */

import { describe, expect, it, vi } from "vitest";
import { RETRY_AFTER_MAX_MS } from "../lib/integrations2/config";
import { sampleEvent } from "../lib/integrations2/events";
import { verifySignature } from "../lib/integrations2/signing";
import {
  buildWebhookRequest,
  classifyWebhookResponse,
  parseRetryAfter,
  sendWebhook,
  type FetchImpl,
} from "../lib/integrations2/connectors/webhook-request";

const payload = sampleEvent("lead.created");
const now = new Date("2026-10-16T09:05:00Z");
const base = {
  url: "https://hooks.example.com/in",
  secret: "whsec_current",
  event: { id: "evt1", type: "lead.created" },
  delivery: { id: "dlv1" },
  payload,
  now,
};

describe("buildWebhookRequest", () => {
  it("POST JSON, manual redirect, abort signal, signed headers that verify", () => {
    const req = buildWebhookRequest(base);
    try {
      expect(req.url).toBe(base.url);
      expect(req.init.method).toBe("POST");
      expect(req.init.redirect).toBe("manual");
      expect(req.init.signal).toBeInstanceOf(AbortSignal);
      expect(req.init.body).toBe(req.body);
      expect(JSON.parse(req.body)).toEqual(payload);
      expect(req.timestamp).toBe(Math.floor(now.getTime() / 1000));
      expect(req.headers).toMatchObject({
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "SocialAuto-Webhooks/1.0",
        "X-SocialAuto-Event": "lead.created",
        "X-SocialAuto-Event-Id": "evt1",
        "X-SocialAuto-Delivery-Id": "dlv1",
        "X-SocialAuto-Timestamp": String(req.timestamp),
      });
      expect(
        verifySignature({
          secret: "whsec_current",
          timestamp: req.headers["X-SocialAuto-Timestamp"],
          rawBody: req.body,
          header: req.headers["X-SocialAuto-Signature"],
          now: now.getTime(),
        })
      ).toEqual({ ok: true, usedPrevious: false });
    } finally {
      req.release();
    }
  });

  it("carries both signatures during rotation and aborts on timeout", async () => {
    const req = buildWebhookRequest({ ...base, previousSecret: "whsec_old", timeoutMs: 5 });
    expect(req.headers["X-SocialAuto-Signature"].split(",")).toHaveLength(2);
    expect(
      verifySignature({ secret: "whsec_old", timestamp: req.timestamp, rawBody: req.body, header: req.headers["X-SocialAuto-Signature"], now: now.getTime() })
    ).toEqual({ ok: true, usedPrevious: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(req.init.signal?.aborted).toBe(true);
    req.release();
  });
});

describe("classifyWebhookResponse", () => {
  it("matrix", () => {
    const outcome = (status: number | null, headers?: Record<string, string>, error?: unknown) =>
      classifyWebhookResponse(status, headers, error, now.getTime());
    expect(outcome(200).outcome).toBe("sent");
    expect(outcome(201).outcome).toBe("sent");
    expect(outcome(204).outcome).toBe("sent");
    expect(outcome(301).outcome).toBe("dead");
    expect(outcome(302).note).toMatch(/redirect/);
    expect(outcome(400).outcome).toBe("dead");
    expect(outcome(401).outcome).toBe("dead");
    expect(outcome(403).outcome).toBe("dead");
    expect(outcome(404).outcome).toBe("dead");
    expect(outcome(408).outcome).toBe("retry");
    expect(outcome(410)).toMatchObject({ outcome: "dead_disable" });
    expect(outcome(422).outcome).toBe("dead");
    expect(outcome(425).outcome).toBe("retry");
    expect(outcome(429).outcome).toBe("retry");
    expect(outcome(500).outcome).toBe("retry");
    expect(outcome(502).outcome).toBe("retry");
    expect(outcome(503).outcome).toBe("retry");
    expect(outcome(599).outcome).toBe("retry");
    expect(outcome(null)).toMatchObject({ outcome: "retry" });
    expect(outcome(null, undefined, new Error("fetch failed"))).toMatchObject({ outcome: "retry", note: "Tarmoq xatosi: fetch failed" });
    expect(outcome(null, undefined, new Error("This operation was aborted")).note).toMatch(/10 s/);
    expect(outcome(200, undefined, new Error("boom")).outcome).toBe("retry"); // an error always wins
  });

  it("honours Retry-After (seconds, HTTP date), capped at 6h, only on retryable statuses", () => {
    const at = now.getTime();
    expect(classifyWebhookResponse(429, { "Retry-After": "120" }, undefined, at)).toMatchObject({ outcome: "retry", retryAfterMs: 120_000 });
    expect(classifyWebhookResponse(503, { "retry-after": "999999" }, undefined, at).retryAfterMs).toBe(RETRY_AFTER_MAX_MS);
    const date = new Date(at + 90_000).toUTCString();
    expect(classifyWebhookResponse(503, { "Retry-After": date }, undefined, at).retryAfterMs).toBe(90_000);
    expect(classifyWebhookResponse(503, { "Retry-After": new Date(at - 90_000).toUTCString() }, undefined, at).retryAfterMs).toBeUndefined();
    expect(classifyWebhookResponse(503, { "Retry-After": "soon" }, undefined, at).retryAfterMs).toBeUndefined();
    expect(classifyWebhookResponse(503, new Headers({ "Retry-After": "30" }), undefined, at).retryAfterMs).toBe(30_000);
    expect(classifyWebhookResponse(400, { "Retry-After": "30" }, undefined, at)).toEqual({ outcome: "dead", note: "HTTP 400 — qabul qiluvchi rad etdi" });
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("0")).toBe(0);
  });
});

describe("sendWebhook", () => {
  it("returns status, masked snippet, duration and classification from a fake fetch", async () => {
    const fetchImpl: FetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(base.url);
      expect(init.method).toBe("POST");
      return new Response('{"ok":true,"echo":"+998901234567"}', { status: 200, headers: { "content-type": "application/json" } });
    });
    let clock = 1000;
    const result = await sendWebhook(buildWebhookRequest(base), fetchImpl, () => (clock += 25));
    expect(result).toEqual({
      status: 200,
      snippet: '{"ok":true,"echo":"+99890***4567"}',
      durationMs: 25,
      classification: { outcome: "sent", note: "HTTP 200" },
    });
  });

  it("429 with Retry-After, 410, and a thrown network error", async () => {
    const r429 = await sendWebhook(buildWebhookRequest(base), async () => new Response("slow down", { status: 429, headers: { "Retry-After": "60" } }));
    expect(r429.classification).toMatchObject({ outcome: "retry", retryAfterMs: 60_000 });
    expect(r429.snippet).toBe("slow down");

    const r410 = await sendWebhook(buildWebhookRequest(base), async () => new Response("", { status: 410 }));
    expect(r410.classification.outcome).toBe("dead_disable");

    const req = buildWebhookRequest(base);
    const release = vi.spyOn(req, "release");
    const failed = await sendWebhook(req, async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.1:443");
    });
    expect(failed.status).toBeNull();
    expect(failed.snippet).toBe("fetch failed: connect ECONNREFUSED 10.0.0.1:443");
    expect(failed.classification.outcome).toBe("retry");
    expect(release).toHaveBeenCalled();
  });

  it("caps a long response body at 300 chars", async () => {
    const result = await sendWebhook(buildWebhookRequest(base), async () => new Response("y".repeat(2000), { status: 500 }));
    expect(result.snippet).toHaveLength(300);
    expect(result.classification.outcome).toBe("retry");
  });
});
