/** ETAP 8 webhook signing: round-trip, tolerance, rotation overlap, tampering. */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HEADER_DELIVERY_ID,
  HEADER_EVENT,
  HEADER_EVENT_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  generateWebhookSecret,
  isWebhookSecret,
  parseSignatureHeader,
  signPayload,
  signatureHeaders,
  verifySignature,
} from "../lib/integrations2/signing";

const secret = "whsec_testsecret";
const body = '{"id":"evt1","type":"lead.created"}';
const ts = 1_760_000_000;
const now = ts * 1000;

describe("secrets", () => {
  it("generates whsec_ + 43 base64url chars, unique", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isWebhookSecret(a)).toBe(true);
    expect(isWebhookSecret("whsec_short")).toBe(false);
    expect(isWebhookSecret("sk_live_x")).toBe(false);
  });
});

describe("signPayload", () => {
  it("is v1=hex(hmac-sha256(secret, ts.body))", () => {
    const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(signPayload(secret, ts, body)).toBe(`v1=${expected}`);
    expect(signPayload(secret, String(ts), body)).toBe(`v1=${expected}`);
  });

  it("parses one or two header values and ignores junk", () => {
    const sig = signPayload(secret, ts, body);
    expect(parseSignatureHeader(sig)).toEqual([sig.slice(3)]);
    expect(parseSignatureHeader(`${sig}, v1=zz, v0=${sig.slice(3)}, ${sig}`)).toHaveLength(2);
    expect(parseSignatureHeader(null)).toEqual([]);
  });
});

describe("verifySignature", () => {
  it("round-trips", () => {
    const header = signPayload(secret, ts, body);
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header, now })).toEqual({ ok: true, usedPrevious: false });
    expect(verifySignature({ secret, timestamp: String(ts), rawBody: body, header: header.toUpperCase().replace("V1", "v1"), now })).toEqual({ ok: true, usedPrevious: false });
  });

  it("tolerance window (default 300s)", () => {
    const header = signPayload(secret, ts, body);
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header, now: now + 300_000 }).ok).toBe(true);
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header, now: now + 301_000 })).toEqual({ ok: false, reason: "expired" });
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header, now: now - 301_000 })).toEqual({ ok: false, reason: "expired" });
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header, now: now + 301_000, toleranceSec: 600 }).ok).toBe(true);
  });

  it("accepts the previous secret during rotation and reports it", () => {
    const old = "whsec_old";
    const header = signPayload(old, ts, body);
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header, now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ secret, previousSecret: old, timestamp: ts, rawBody: body, header, now })).toEqual({ ok: true, usedPrevious: true });
    // A sender in overlap sends both; a receiver that only knows the new one still verifies.
    const both = `${signPayload(secret, ts, body)},${header}`;
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header: both, now })).toEqual({ ok: true, usedPrevious: false });
  });

  it("rejects tampering, missing and malformed input", () => {
    const header = signPayload(secret, ts, body);
    expect(verifySignature({ secret, timestamp: ts, rawBody: body.replace("lead", "deal"), header, now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ secret, timestamp: ts + 1, rawBody: body, header, now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ secret: "whsec_other", timestamp: ts, rawBody: body, header, now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header: null, now })).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature({ secret, timestamp: null, rawBody: body, header, now })).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature({ secret, timestamp: "abc", rawBody: body, header, now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header: "v1=nothex", now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignature({ secret, timestamp: ts, rawBody: body, header: "v2=" + header.slice(3), now })).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("signatureHeaders", () => {
  it("emits the X-SocialAuto-* set, two signatures during overlap", () => {
    const headers = signatureHeaders({ event: "lead.created", eventId: "evt1", deliveryId: "dlv1", timestamp: ts, rawBody: body, secret });
    expect(headers).toEqual({
      [HEADER_EVENT]: "lead.created",
      [HEADER_EVENT_ID]: "evt1",
      [HEADER_DELIVERY_ID]: "dlv1",
      [HEADER_TIMESTAMP]: String(ts),
      [HEADER_SIGNATURE]: signPayload(secret, ts, body),
    });
    expect(Object.keys(headers)).toEqual([
      "X-SocialAuto-Event",
      "X-SocialAuto-Event-Id",
      "X-SocialAuto-Delivery-Id",
      "X-SocialAuto-Timestamp",
      "X-SocialAuto-Signature",
    ]);
    const overlap = signatureHeaders({ event: "lead.created", eventId: "evt1", deliveryId: "dlv1", timestamp: ts, rawBody: body, secret, previousSecret: "whsec_old" });
    expect(overlap[HEADER_SIGNATURE]).toBe(`${signPayload(secret, ts, body)},${signPayload("whsec_old", ts, body)}`);
  });
});
