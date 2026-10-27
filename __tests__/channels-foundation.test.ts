/**
 * Channel foundation (audit 2026-10-26, T0–T2, T7): capability matrix,
 * Instagram normalisation, outbound retries, the credential vault (envelope
 * encryption, rotation, refresh, revoke, tenant isolation), the webhook
 * gateway and log redaction.
 */
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const { redis, notify } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    notify: vi.fn(async () => 1),
    redis: {
      store,
      set: vi.fn(async (key: string, value: string, _ex?: string, _ttl?: number, nx?: string) => {
        if (nx === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
      incr: vi.fn(async (key: string) => {
        const next = Number(store.get(key) ?? 0) + 1;
        store.set(key, String(next));
        return next;
      }),
      expire: vi.fn(async () => 1),
    },
  };
});
vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => redis }));
vi.mock("@/lib/telegram/notify", () => ({ notifyWorkspaceChats: notify }));

import { capabilityMatrix, dmWindowOpen, privateReplyAllowed } from "@/lib/channels/capabilities";
import { channelFetch, consumeTenantCall } from "@/lib/channels/http";
import { normalizeInstagramWebhook } from "@/lib/channels/instagram";
import { runCredentialRefresh } from "@/lib/channels/refresh";
import { registerAdapter } from "@/lib/channels/registry";
import { ChannelError, type ChannelAdapter } from "@/lib/channels/types";
import { VaultError, decryptPayload, encryptPayload, isCredentialUsable, kekRingFromEnv, listCredentials, loadCredentials, putCredential, revokeCredential, rewrapCredentials } from "@/lib/channels/vault";
import { installConsoleRedaction, redactText, redactValue } from "@/lib/security/redact";
import { logRejectedWebhook, readLimitedBody, seenBefore } from "@/lib/webhooks/gateway";

const KEY1 = randomBytes(32).toString("base64");
const KEY2 = randomBytes(32).toString("base64");
const ring1 = kekRingFromEnv({ CREDENTIAL_KEKS: `1:${KEY1}`, CREDENTIAL_KEK_VERSION: "1" });
const ring2 = kekRingFromEnv({ CREDENTIAL_KEKS: `1:${KEY1},2:${KEY2}`, CREDENTIAL_KEK_VERSION: "2" });
const DAY = 86_400_000;
const SECRET = "EAAGsecretTokenValue1234567890abcdef";

beforeEach(() => {
  resetDb();
  redis.store.clear();
  notify.mockClear();
  db.seed("workspace", { id: "wsA", name: "A" });
  db.seed("workspace", { id: "wsB", name: "B" });
});

describe("capability matrix", () => {
  it("is config with field-level overrides; bad overrides are ignored", () => {
    expect(capabilityMatrix({}).threads.supports_dm).toBe(false);
    const m = capabilityMatrix({ CHANNEL_CAPABILITIES_JSON: '{"instagram":{"publish_daily_limit":100,"supports_dm":"yes","nope":1}}' });
    expect(m.instagram.publish_daily_limit).toBe(100);
    expect(m.instagram.supports_dm).toBe(true);
    expect(capabilityMatrix({ CHANNEL_CAPABILITIES_JSON: "{oops" }).instagram.publish_daily_limit).toBe(50);
  });
  it("private reply window and DM window", () => {
    const now = new Date();
    expect(privateReplyAllowed("instagram", new Date(now.getTime() - 6 * DAY), now)).toBe(true);
    expect(privateReplyAllowed("instagram", new Date(now.getTime() - 8 * DAY), now)).toBe(false);
    expect(privateReplyAllowed("threads", now, now)).toBe(false);
    expect(dmWindowOpen("instagram", new Date(now.getTime() - 25 * 3600_000), now)).toBe(false);
    expect(dmWindowOpen("telegram", null, now)).toBe(true);
    expect(dmWindowOpen("youtube", now, now)).toBe(false);
  });
});

describe("Instagram normalisation", () => {
  it("maps comments, DMs, postbacks; skips echoes and own comments", () => {
    const events = normalizeInstagramWebhook(
      {
        object: "instagram",
        entry: [
          {
            id: "ig1",
            time: 1_761_500_000,
            changes: [
              { field: "comments", value: { id: "c1", text: "narx?", from: { id: "u1", username: "ali" }, media: { id: "m1", original_media_id: "m0" } } },
              { field: "comments", value: { id: "c2", text: "own", from: { id: "ig1" }, media: { id: "m1" } } },
            ],
            messaging: [
              { sender: { id: "u2" }, timestamp: 1_761_500_000_000, message: { mid: "mid1", text: "salom", attachments: [{ type: "image", payload: { url: "https://x/y.jpg" } }] } },
              { sender: { id: "ig1" }, message: { mid: "mid2", text: "echo", is_echo: true } },
              { sender: { id: "u3" }, timestamp: 1_761_500_000_000, postback: { mid: "pb1", title: "Narx", payload: "PRICE" } },
            ],
          },
        ],
      },
      "webhook_event:1"
    );
    expect(events.map((e) => [e.kind, e.externalId])).toEqual([
      ["comment", "c1"],
      ["dm", "mid1"],
      ["postback", "pb1"],
    ]);
    expect(events[0]).toMatchObject({ channel: "instagram", accountId: "ig1", threadId: "m1", parentId: "m0", author: { externalId: "u1", username: "ali" }, rawRef: "webhook_event:1" });
    expect(events[1].media[0]).toMatchObject({ type: "image", url: "https://x/y.jpg" });
  });
});

describe("channelFetch", () => {
  it("waits Retry-After once on 429, retries 5xx with backoff, gives up with rate_limit", async () => {
    const sleep = vi.fn(async () => {});
    const responses = [new Response("", { status: 429, headers: { "retry-after": "2" } }), new Response("", { status: 502 }), new Response("ok", { status: 200 })];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const res = await channelFetch("https://graph.example/x", { fetchImpl: fetchImpl as never, sleep });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(2000);

    const always429 = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "1" } }));
    await expect(channelFetch("https://graph.example/x", { fetchImpl: always429 as never, sleep })).rejects.toMatchObject({ kind: "rate_limit" });
  });

  it("sends the idempotency key and enforces the per-tenant hourly cap", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => new Response(new Headers(init.headers).get("idempotency-key") ?? ""));
    const res = await channelFetch("https://graph.example/x", { fetchImpl: fetchImpl as never, idempotencyKey: "post-1:ig", tenantId: "wsA" });
    expect(await res.text()).toBe("post-1:ig");
    expect(await consumeTenantCall("wsZ", 2)).toBe(true);
    expect(await consumeTenantCall("wsZ", 2)).toBe(true);
    expect(await consumeTenantCall("wsZ", 2)).toBe(false);
  });
});

describe("credential vault", () => {
  it("envelope-encrypts: no plaintext in the row, round-trips, wrong KEK fails", () => {
    const sealed = encryptPayload({ accessToken: SECRET }, ring1);
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    expect(sealed.keyVersion).toBe(1);
    expect(decryptPayload<{ accessToken: string }>(sealed, ring1).accessToken).toBe(SECRET);
    const other = kekRingFromEnv({ CREDENTIAL_KEKS: `1:${KEY2}`, CREDENTIAL_KEK_VERSION: "1" });
    expect(() => decryptPayload(sealed, other)).toThrow(VaultError);
  });

  it("falls back to a KEK derived from ENCRYPTION_KEY; rejects malformed KEKs", () => {
    expect(kekRingFromEnv({ ENCRYPTION_KEY: "x".repeat(64) }).active).toBe(0);
    expect(() => kekRingFromEnv({ CREDENTIAL_KEKS: "1:short" })).toThrow(VaultError);
    expect(() => kekRingFromEnv({})).toThrow(VaultError);
  });

  it("stores, lists without secrets, isolates tenants, rotates, revokes", async () => {
    const pub = await putCredential({ workspaceId: "wsA", channel: "telegram", externalAccountId: "bot1", secret: { accessToken: SECRET }, scopes: ["bot"] }, ring1);
    expect(JSON.stringify(db.rows("channelCredential"))).not.toContain(SECRET); // "DB dump" check
    expect(JSON.stringify(pub)).not.toContain(SECRET);
    expect(Object.keys(pub)).not.toEqual(expect.arrayContaining(["encryptedPayload", "dekEncrypted"]));
    expect(JSON.stringify(await listCredentials("wsA"))).not.toContain("encryptedPayload");

    expect((await loadCredentials("wsA", pub.id, ring1)).accessToken).toBe(SECRET);
    await expect(loadCredentials("wsB", pub.id, ring1)).rejects.toBeInstanceOf(VaultError); // IDOR
    expect(await listCredentials("wsB")).toEqual([]);
    expect(await revokeCredential("wsB", pub.id, ring1)).toBe(false);

    expect(await rewrapCredentials(ring2)).toBe(1);
    expect(db.rows("channelCredential")[0].keyVersion).toBe(2);
    expect((await loadCredentials("wsA", pub.id, ring2)).accessToken).toBe(SECRET);

    expect(await isCredentialUsable("wsA", "telegram", "bot1")).toBe(true);
    expect(await revokeCredential("wsA", pub.id, ring2)).toBe(true);
    expect(await isCredentialUsable("wsA", "telegram", "bot1")).toBe(false);
    await expect(loadCredentials("wsA", pub.id, ring2)).rejects.toBeInstanceOf(VaultError);
    const shredded = decryptPayload<{ accessToken: string }>(db.rows("channelCredential")[0] as never, ring2);
    expect(shredded.accessToken).toBe("");
  });
});

describe("credential refresh worker", () => {
  const fake = (over: Partial<ChannelAdapter>): ChannelAdapter => ({
    channel: "threads",
    capabilities: () => capabilityMatrix().threads,
    connect: vi.fn(),
    refreshCredentials: vi.fn(async () => ({ accessToken: "NEWTOKEN-123", expiresAt: new Date(Date.now() + 60 * DAY) })),
    checkCredentials: vi.fn(async () => ({ ok: true })),
    publish: vi.fn(),
    continuePublish: vi.fn(),
    replyComment: vi.fn(),
    hideComment: vi.fn(),
    sendDm: vi.fn(),
    privateReply: vi.fn(),
    fetchInsights: vi.fn(),
    ...over,
  }) as ChannelAdapter;

  it("refreshes a token 10 days before expiry and leaves fresh ones alone", async () => {
    const adapter = fake({});
    registerAdapter(adapter);
    await putCredential({ workspaceId: "wsA", channel: "threads", externalAccountId: "t1", secret: { accessToken: "OLD" }, expiresAt: new Date(Date.now() + 5 * DAY) }, ring1);
    await putCredential({ workspaceId: "wsA", channel: "threads", externalAccountId: "t2", secret: { accessToken: "FRESH" }, expiresAt: new Date(Date.now() + 40 * DAY) }, ring1);
    const summary = await runCredentialRefresh(new Date(), ring1);
    expect(summary).toMatchObject({ refreshed: 1, skipped: 1, failed: 0 });
    const t1 = db.rows("channelCredential").find((r) => r.externalAccountId === "t1")!;
    expect(decryptPayload<{ accessToken: string }>(t1 as never, ring1).accessToken).toBe("NEWTOKEN-123");
  });

  it("an auth failure marks ERROR, stops usability and alerts the owner once", async () => {
    registerAdapter(fake({ refreshCredentials: vi.fn(async () => { throw new ChannelError("auth", "revoked"); }) }));
    await putCredential({ workspaceId: "wsA", channel: "threads", externalAccountId: "t1", label: "@shop", secret: { accessToken: "OLD" }, expiresAt: new Date(Date.now() + DAY) }, ring1);
    await runCredentialRefresh(new Date(), ring1);
    expect(db.rows("channelCredential")[0]).toMatchObject({ status: "ERROR", lastErrorCode: "auth" });
    expect(await isCredentialUsable("wsA", "threads", "t1")).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String((notify.mock.calls[0] as unknown[])[1])).not.toContain("OLD");
  });
});

describe("webhook gateway", () => {
  it("refuses bodies over the limit, declared or streamed", async () => {
    expect(await readLimitedBody(new Request("https://x", { method: "POST", body: "a".repeat(20), headers: { "content-length": "20" } }), 10)).toEqual({ ok: false, status: 413 });
    expect(await readLimitedBody(new Request("https://x", { method: "POST", body: "a".repeat(20) }), 10)).toEqual({ ok: false, status: 413 });
    expect(await readLimitedBody(new Request("https://x", { method: "POST", body: '{"a":1}' }))).toEqual({ ok: true, body: '{"a":1}' });
  });

  it("dedups (channel, id) and rate-limits rejection logs without the body", async () => {
    expect(await seenBefore("meta", "abc")).toBe(false);
    expect(await seenBefore("meta", "abc")).toBe(true);
    expect(await seenBefore("telegram", "abc")).toBe(false);
    for (let i = 0; i < 9; i++) await logRejectedWebhook("meta", "signature verification failed", { bodyLength: 10 });
    const logs = db.rows("operationalEvent");
    expect(logs).toHaveLength(5);
    expect(JSON.stringify(logs)).not.toContain("bodyPreview");
  });
});

describe("log redaction", () => {
  it("masks tokens, secrets, phones and e-mails; keeps ids and timestamps", () => {
    const line = redactText(
      `GET https://graph.instagram.com/me?access_token=${SECRET}&fields=id bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq Bearer abc.def.ghi1234 phone +998 90 123 45 67 or 998901234567 mail ali.valiyev@gmail.com ts 1761500000 id 17841400000000000 key sk-ant-abcdefghijklmnopqrstuvwx`
    );
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq");
    expect(line).not.toContain("123 45 67");
    expect(line).not.toContain("998901234567");
    expect(line).not.toContain("ali.valiyev");
    expect(line).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx");
    expect(line).toContain("gmail.com");
    expect(line).toContain("1761500000");
    expect(line).toContain("17841400000000000");
  });

  it("masks secret keys in objects and errors; console install is idempotent", () => {
    const value = redactValue({ accessToken: "x", nested: { phone: "+998901234567", note: "ok" }, err: new Error(`failed token=${SECRET}`) }) as Record<string, unknown>;
    expect(value.accessToken).toBe("[redacted]");
    expect(JSON.stringify(value.nested)).not.toContain("901234567");
    expect((value.err as Error).message).not.toContain(SECRET);

    const lines: unknown[][] = [];
    const fakeConsole = { log: (...a: unknown[]) => lines.push(a), info: () => {}, warn: () => {}, error: (...a: unknown[]) => lines.push(a), debug: () => {} } as unknown as Console;
    installConsoleRedaction(fakeConsole);
    installConsoleRedaction(fakeConsole);
    fakeConsole.error("refresh failed", { token: SECRET }, `url?access_token=${SECRET}`);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(lines).toHaveLength(1);
  });
});
