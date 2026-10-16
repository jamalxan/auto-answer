/**
 * ETAP 8 pure pieces: config, the v1 payload schema and assembler, dedupe
 * keys, snippet masking, samples and the preview.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTEGRATION2_TYPES,
  LEAD_PIPELINE_TYPES,
  OUTBOUND_EVENT_INFO,
  OUTBOUND_EVENT_TYPES,
  isLeadPipelineType,
  isOutboundBusEnabled,
  isOutboundEventType,
} from "../lib/integrations2/config";
import {
  bandForScore,
  buildPayload,
  dedupeKeyFor,
  maskSnippet,
  normalizeBand,
  outboundPayloadV1Schema,
  sampleEvent,
  type LeadLike,
} from "../lib/integrations2/events";
import { previewPayload, previewSample } from "../lib/integrations2/payload-preview";

afterEach(() => vi.unstubAllEnvs());

const lead: LeadLike = {
  id: "lead1",
  name: "Dilnoza",
  phoneE164: "+998901234567",
  igUsername: "dilnoza",
  productInterest: "IELTS",
  summary: "Narx so'radi",
  source: "CAMPAIGN",
  campaignName: "Kuz",
  triggerKeyword: "ielts",
  isTest: false,
  createdAt: new Date("2026-10-16T09:00:00Z"),
  conversationId: "conv1",
  transcript: "Mijoz: salom",
};

describe("config", () => {
  it("kill switch", () => {
    expect(isOutboundBusEnabled()).toBe(true);
    vi.stubEnv("INTEGRATIONS_BUS_DISABLED", "1");
    expect(isOutboundBusEnabled()).toBe(false);
    vi.stubEnv("INTEGRATIONS_BUS_DISABLED", "0");
    expect(isOutboundBusEnabled()).toBe(true);
  });

  it("vocabularies have labels and the lead pipeline list excludes the bus types", () => {
    expect(OUTBOUND_EVENT_TYPES).toHaveLength(7);
    for (const type of OUTBOUND_EVENT_TYPES) {
      expect(OUTBOUND_EVENT_INFO[type].label).toBeTruthy();
      expect(OUTBOUND_EVENT_INFO[type].description).toBeTruthy();
    }
    expect(isOutboundEventType("lead.hot")).toBe(true);
    expect(isOutboundEventType("lead.deleted")).toBe(false);
    expect(LEAD_PIPELINE_TYPES).toEqual(["TELEGRAM", "AMOCRM", "BITRIX24"]);
    for (const type of INTEGRATION2_TYPES) expect(isLeadPipelineType(type)).toBe(false);
    expect(isLeadPipelineType("AMOCRM")).toBe(true);
  });
});

describe("dedupeKeyFor", () => {
  it("joins type, subject and discriminators; skips empty parts", () => {
    expect(dedupeKeyFor("lead.created", "lead1")).toBe("lead.created:lead1");
    expect(dedupeKeyFor("contact.tagged", "c1", "vip")).toBe("contact.tagged:c1:vip");
    expect(dedupeKeyFor("lead.updated", "lead1", new Date("2026-10-16T09:00:00Z"))).toBe(
      "lead.updated:lead1:2026-10-16T09:00:00.000Z"
    );
    expect(dedupeKeyFor("deal.stage_changed", "d1", "s2", null, undefined, "", 5)).toBe("deal.stage_changed:d1:s2:5");
  });
});

describe("buildPayload", () => {
  it("assembles a lead event with score, source, extra and conversation url", () => {
    const payload = buildPayload({
      type: "lead.created",
      eventId: "evt1",
      occurredAt: new Date("2026-10-16T09:00:03Z"),
      workspace: { id: "ws1", name: "Demo" },
      account: { id: "ig1", username: "demo" },
      lead,
      insight: { score: 72, signals: [{ signal: "phone_provided", points: 30 }], budget: "1 mln" },
      contact: { id: "c1", status: "ACTIVE", tags: ["ielts", "ielts", " hot "], assignedMember: { id: "m1", name: "Aziza" } },
      source: { adId: "ad1" },
      baseUrl: "https://app.example.uz/",
    });
    expect(outboundPayloadV1Schema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      id: "evt1",
      type: "lead.created",
      version: 1,
      occurred_at: "2026-10-16T09:00:03.000Z",
      is_test: false,
      account: { id: "ig1", username: "demo" },
      lead: {
        id: "lead1",
        phone: "+998901234567",
        product: "IELTS",
        is_repeat: false,
        created_at: "2026-10-16T09:00:00.000Z",
        conversation_url: "https://app.example.uz/inbox?conversation=conv1",
      },
      score: { value: 72, temperature: "HOT", band: "hot", signals: [{ signal: "phone_provided", points: 30 }] },
      source: { kind: "campaign", channel: "instagram_dm", campaign: "Kuz", keyword: "ielts", ad_id: "ad1", ref: null },
      contact: { id: "c1", tags: ["ielts", "hot"], assigned_member: { id: "m1", name: "Aziza" } },
      extra: { email: null, budget: "1 mln", location: null },
      deal: null,
      handoff: null,
      broadcast: null,
    });
    expect(payload.transcript).toBeUndefined();
  });

  it("is_test follows the lead unless overridden; transcript only on request", () => {
    const base = { type: "lead.hot" as const, eventId: "e", workspace: { id: "w", name: "W" } };
    expect(buildPayload({ ...base, lead: { ...lead, isTest: true } }).is_test).toBe(true);
    expect(buildPayload({ ...base, lead: { ...lead, isTest: true }, isTest: false }).is_test).toBe(false);
    expect(buildPayload({ ...base, lead, includeTranscript: true }).transcript).toBe("Mijoz: salom");
    expect(buildPayload({ ...base, lead: { ...lead, transcript: null }, includeTranscript: true }).transcript).toBeUndefined();
  });

  it("uses the stored temperature when present, the injected bandFor otherwise, and clamps the score", () => {
    const base = { type: "lead.hot" as const, eventId: "e", workspace: { id: "w", name: "W" }, lead };
    expect(buildPayload({ ...base, insight: { score: 72, temperature: "CUSTOMER" } }).score).toMatchObject({ temperature: "CUSTOMER", band: "hot" });
    expect(buildPayload({ ...base, insight: { score: 72 }, bandFor: () => "Very hot" }).score).toMatchObject({ band: "very_hot", temperature: "HOT" });
    expect(buildPayload({ ...base, insight: { score: 140 } }).score?.value).toBe(100);
    expect(buildPayload({ ...base, insight: { score: 20 } }).score).toMatchObject({ band: "cold", temperature: "COLD" });
    expect(buildPayload({ ...base, insight: { score: 45, signals: [{ signal: "x", points: Number.NaN }] } }).score).toMatchObject({ band: "warm", temperature: "WARM", signals: [] });
    expect(buildPayload({ ...base, insight: { score: 45 }, thresholds: { warm: 50, hot: 70, veryHot: 90 } }).score?.band).toBe("cold");
  });

  it("derives the source channel from the contact when there is no lead", () => {
    const payload = buildPayload({
      type: "contact.tagged",
      eventId: "e",
      workspace: { id: "w", name: "W" },
      contact: { id: "c1", status: "NEW", source: "COMMENT", tags: ["vip"] },
    });
    expect(payload.lead).toBeNull();
    expect(payload.score).toBeNull();
    expect(payload.source).toEqual({ kind: "comment", channel: "comment", campaign: null, keyword: null, ad_id: null, ref: null });
    expect(payload.is_test).toBe(false);
  });

  it("broadcast / deal / handoff sections", () => {
    const payload = buildPayload({
      type: "deal.stage_changed",
      eventId: "e",
      workspace: { id: "w", name: "W" },
      deal: { id: "d1", pipelineName: "Sotuv", stageName: "Taklif", stageId: "s2", fromStageName: "Yangi" },
      handoff: { id: "h1", reason: "complaint", state: "HANDOFF_PENDING", openedAt: "2026-10-16T09:00:00.000Z" },
      broadcast: { id: "b1", name: "Oktabr", sent: 1, failed: 0, skipped: 2, completedAt: new Date("2026-10-16T10:00:00Z") },
    });
    expect(payload.deal).toEqual({ id: "d1", pipeline: "Sotuv", stage: "Taklif", stage_id: "s2", from_stage: "Yangi" });
    expect(payload.handoff).toEqual({ id: "h1", reason: "complaint", state: "HANDOFF_PENDING", opened_at: "2026-10-16T09:00:00.000Z" });
    expect(payload.broadcast).toMatchObject({ id: "b1", sent: 1, skipped: 2, completed_at: "2026-10-16T10:00:00.000Z" });
    expect(payload.source).toBeNull();
  });
});

describe("bands", () => {
  it("TZ 24 defaults and normalisation", () => {
    expect([0, 29, 30, 59, 60, 79, 80, 100].map((s) => bandForScore(s))).toEqual([
      "cold", "cold", "warm", "warm", "hot", "hot", "very_hot", "very_hot",
    ]);
    expect(normalizeBand("Very hot")).toBe("very_hot");
    expect(normalizeBand("HOT")).toBe("hot");
    expect(normalizeBand("nonsense")).toBe("cold");
  });
});

describe("maskSnippet", () => {
  it("masks E.164 and bare digit runs, collapses whitespace, caps the length", () => {
    expect(maskSnippet('{"phone":"+998901234567","ok":true}')).toBe('{"phone":"+99890***4567","ok":true}');
    expect(maskSnippet("tel 998901234567 \n\n and 12345678")).toBe("tel 998901***4567 and 12345678");
    expect(maskSnippet(null)).toBe("");
    const long = maskSnippet("x".repeat(1000));
    expect(long).toHaveLength(300);
    expect(long.endsWith("…")).toBe(true);
    expect(maskSnippet("abc", 10)).toBe("abc");
  });
});

describe("schema", () => {
  it("rejects wrong version, unknown type, out-of-range score; accepts every sample", () => {
    const ok = sampleEvent("lead.created");
    expect(outboundPayloadV1Schema.safeParse({ ...ok, version: 2 }).success).toBe(false);
    expect(outboundPayloadV1Schema.safeParse({ ...ok, type: "lead.deleted" }).success).toBe(false);
    expect(outboundPayloadV1Schema.safeParse({ ...ok, score: { ...ok.score, value: 101 } }).success).toBe(false);
    expect(outboundPayloadV1Schema.safeParse({ ...ok, lead: undefined }).success).toBe(false);
    for (const type of OUTBOUND_EVENT_TYPES) {
      const sample = sampleEvent(type);
      expect(sample.type).toBe(type);
      expect(sample.is_test).toBe(true);
      expect(outboundPayloadV1Schema.safeParse(sample).success).toBe(true);
      expect(previewSample(type)).toMatchObject({ ok: true });
    }
    expect(sampleEvent("broadcast.completed").lead).toBeNull();
    expect(sampleEvent("lead.hot").lead?.conversation_url).toBe("https://app.socialauto.uz/inbox?conversation=conv_sample01");
  });

  it("previewPayload reports issues instead of throwing", () => {
    const good = previewPayload({ type: "lead.created", eventId: "e", workspace: { id: "w", name: "W" }, lead });
    expect(good.ok).toBe(true);
    if (good.ok) expect(JSON.parse(good.json).lead.id).toBe("lead1");
    const bad = previewPayload({ type: "lead.created", eventId: "", workspace: { id: "w", name: "W" }, lead });
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.issues[0]).toMatch(/^id:/);
  });
});
