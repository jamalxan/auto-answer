/**
 * ETAP 8 — the bus front half: emit (idempotent, fire-and-forget, kill
 * switch), materialise (frozen payload, subscription matching, is_test
 * exclusion, the lead.hot rule) and the CRM listener.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("REDIS_URL", "redis://localhost:6379");

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", async () => {
  const { FakeRedis } = await import("./helpers/integrations2");
  return { getRedisConnection: () => new FakeRedis() };
});
vi.mock("../lib/integrations2/queue", async (original) => ({
  ...(await original<typeof import("../lib/integrations2/queue")>()),
  enqueueMaterialize: vi.fn(async () => {}),
  enqueueOutboundDelivery: vi.fn(async () => {}),
}));

import { emitHandoffOpened, emitOutbound } from "../lib/integrations2/emit";
import { handleCrmEvent } from "../lib/integrations2/crm-listener";
import { materializeEvent } from "../lib/integrations2/materialize";
import { MATERIALIZE_DELAY_MS } from "../lib/integrations2/config";
import { enqueueMaterialize, enqueueOutboundDelivery } from "../lib/integrations2/queue";
import type { CrmEvent } from "../lib/crm/hooks";
import { db, resetDb } from "./helpers/db-instance";
import { seedLead, seedSubscription, seedWebhook, seedWorkspace } from "./helpers/integrations2";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model) as Row[];

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  vi.stubEnv("INTEGRATIONS_BUS_DISABLED", "");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  seedWorkspace();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
});

async function emitLead(id = "l1", type: "lead.created" | "lead.hot" = "lead.created") {
  return emitOutbound({
    workspaceId: "w1",
    type,
    subjectType: "lead",
    subjectId: id,
    instagramAccountId: "w1_a1",
    dedupeKey: `${type}:${id}`,
  });
}

describe("emitOutbound", () => {
  it("inserts one event and queues materialisation 3 s later for lead events", async () => {
    const id = await emitLead();
    expect(id).toBeTruthy();
    expect(rows("outboundEvent")).toHaveLength(1);
    expect(enqueueMaterialize).toHaveBeenCalledWith(id, MATERIALIZE_DELAY_MS);
  });

  it("is idempotent on the dedupe key (retry, second code path)", async () => {
    await emitLead();
    const second = await emitLead();
    expect(second).toBeNull();
    expect(rows("outboundEvent")).toHaveLength(1);
    expect(enqueueMaterialize).toHaveBeenCalledTimes(1);
  });

  it("queues non-lead events without delay", async () => {
    const id = await emitOutbound({ workspaceId: "w1", type: "broadcast.completed", subjectType: "broadcast", subjectId: "b1", dedupeKey: "broadcast.completed:b1" });
    expect(enqueueMaterialize).toHaveBeenCalledWith(id, 0);
  });

  it("is a no-op under INTEGRATIONS_BUS_DISABLED=1", async () => {
    vi.stubEnv("INTEGRATIONS_BUS_DISABLED", "1");
    expect(await emitLead()).toBeNull();
    expect(rows("outboundEvent")).toHaveLength(0);
    expect(enqueueMaterialize).not.toHaveBeenCalled();
  });

  it("is a no-op without Redis", async () => {
    vi.stubEnv("REDIS_URL", "");
    expect(await emitLead()).toBeNull();
    expect(rows("outboundEvent")).toHaveLength(0);
  });

  it("never throws, even when the database does", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(emitOutbound({ workspaceId: "w1", type: "lead.created", subjectType: "lead", subjectId: "x", dedupeKey: undefined as unknown as string })).resolves.not.toThrow();
    spy.mockRestore();
  });

  it("emitHandoffOpened resolves the workspace from the conversation", async () => {
    db.seed("conversation", { id: "c1", workspaceId: "w1", instagramAccountId: "w1_a1", igUserId: "u1" });
    await emitHandoffOpened("h1", "c1");
    const event = rows("outboundEvent")[0];
    expect(event).toMatchObject({ type: "handoff.opened", subjectId: "h1", workspaceId: "w1", dedupeKey: "handoff.opened:h1" });
  });
});

describe("materializeEvent", () => {
  it("freezes the payload, creates one delivery per matching subscription and queues it", async () => {
    seedLead({ temperature: "HOT" });
    const hook = seedWebhook();
    const sub = seedSubscription(hook.id as string, "lead.created");
    const eventId = (await emitLead())!;

    const result = await materializeEvent(eventId);
    expect(result.deliveries).toBe(1);

    const event = rows("outboundEvent").find((e) => e.id === eventId)!;
    const payload = event.payload as Row;
    expect(event.materializedAt).toBeInstanceOf(Date);
    expect(payload).toMatchObject({ id: eventId, type: "lead.created", version: 1, is_test: false });
    expect((payload.lead as Row).phone).toBe("+998901234567");
    expect((payload.score as Row).temperature).toBe("HOT");

    const deliveries = rows("outboundDelivery");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ eventId, integrationId: hook.id, subscriptionId: sub.id, status: "PENDING", attempts: 0 });
    expect(enqueueOutboundDelivery).toHaveBeenCalledWith(deliveries[0].id, 0, 0);
  });

  it("never rebuilds a frozen payload (redelivery sends what the first attempt sent)", async () => {
    const lead = seedLead({ temperature: "WARM" });
    const hook = seedWebhook();
    seedSubscription(hook.id as string);
    const eventId = (await emitLead())!;
    await materializeEvent(eventId);
    const before = JSON.stringify(rows("outboundEvent").find((e) => e.id === eventId)!.payload);

    lead.name = "Boshqa ism";
    expect((await materializeEvent(eventId)).skipped).toBe("already_materialized");
    expect(JSON.stringify(rows("outboundEvent").find((e) => e.id === eventId)!.payload)).toBe(before);
    expect(rows("outboundDelivery")).toHaveLength(1);
  });

  it("matches subscription filters and gives nothing to integrations without a subscription", async () => {
    seedLead({ temperature: "COLD" });
    const hotOnly = seedWebhook({ id: "int_hot" });
    seedSubscription(hotOnly.id as string, "lead.created", { v: 1, temperatures: ["HOT"] });
    const everything = seedWebhook({ id: "int_all" });
    seedSubscription(everything.id as string, "lead.created");
    const otherEvent = seedWebhook({ id: "int_other" });
    seedSubscription(otherEvent.id as string, "handoff.opened");
    seedWebhook({ id: "int_none" });

    await materializeEvent((await emitLead())!);
    expect(rows("outboundDelivery").map((d) => d.integrationId)).toEqual(["int_all"]);
  });

  it("excludes test events unless the subscription asks for them", async () => {
    seedLead({ temperature: "HOT", isTest: true });
    const plain = seedWebhook({ id: "int_plain" });
    seedSubscription(plain.id as string);
    const withTest = seedWebhook({ id: "int_test" });
    seedSubscription(withTest.id as string, "lead.created", { v: 1, include_test: true });

    await materializeEvent((await emitLead())!);
    expect(rows("outboundDelivery").map((d) => d.integrationId)).toEqual(["int_test"]);
    expect((rows("outboundEvent")[0].payload as Row).is_test).toBe(true);
  });

  it("ignores inactive subscriptions and disabled integrations", async () => {
    seedLead({ temperature: "HOT" });
    const off = seedWebhook({ id: "int_off" });
    seedSubscription(off.id as string, "lead.created", { v: 1 }, false);
    const disabled = seedWebhook({ id: "int_disabled", status: "DISABLED" });
    seedSubscription(disabled.id as string);
    await materializeEvent((await emitLead())!);
    expect(rows("outboundDelivery")).toHaveLength(0);
  });

  it("holds deliveries of a BROKEN integration without queueing them", async () => {
    seedLead({ temperature: "HOT" });
    const broken = seedWebhook({ id: "int_broken", status: "BROKEN" });
    seedSubscription(broken.id as string);
    await materializeEvent((await emitLead())!);
    expect(rows("outboundDelivery")).toHaveLength(1);
    expect(rows("outboundDelivery")[0].nextAttemptAt).toBeNull();
    expect(enqueueOutboundDelivery).not.toHaveBeenCalled();
  });

  it("adds the transcript only for subscriptions that asked for it", async () => {
    const lead = seedLead({ temperature: "HOT" });
    lead.transcript = "Mijoz: salom";
    const hook = seedWebhook();
    seedSubscription(hook.id as string, "lead.created", { v: 1, include_transcript: true });
    await materializeEvent((await emitLead())!);
    expect((rows("outboundEvent")[0].payload as Row).transcript).toBe("Mijoz: salom");
  });

  it("lead.hot rule: a lead that is HOT at creation also emits lead.hot, once", async () => {
    seedLead({ temperature: "HOT" });
    const hook = seedWebhook();
    seedSubscription(hook.id as string, "lead.hot");
    await materializeEvent((await emitLead())!);
    const hot = rows("outboundEvent").filter((e) => e.type === "lead.hot");
    expect(hot).toHaveLength(1);
    expect(hot[0].dedupeKey).toBe("lead.hot:l1");
    // a second lead.created materialisation (or the CRM becameHot) cannot emit it twice
    expect(await emitLead("l1", "lead.hot")).toBeNull();
  });

  it("a COLD lead does not emit lead.hot", async () => {
    seedLead({ temperature: "COLD" });
    await materializeEvent((await emitLead())!);
    expect(rows("outboundEvent").filter((e) => e.type === "lead.hot")).toHaveLength(0);
  });

  it("marks an event whose subject is gone as materialised without deliveries", async () => {
    const hook = seedWebhook();
    seedSubscription(hook.id as string);
    const eventId = (await emitLead("missing"))!;
    expect((await materializeEvent(eventId)).skipped).toBe("subject_missing");
    expect(rows("outboundEvent")[0].materializedAt).toBeInstanceOf(Date);
    expect(rows("outboundDelivery")).toHaveLength(0);
  });

  it("does nothing under INTEGRATIONS_BUS_DISABLED=1", async () => {
    seedLead({ temperature: "HOT" });
    const eventId = (await emitLead())!;
    vi.stubEnv("INTEGRATIONS_BUS_DISABLED", "1");
    expect((await materializeEvent(eventId)).skipped).toBe("INTEGRATIONS_BUS_DISABLED");
    expect(rows("outboundEvent")[0].materializedAt).toBeNull();
  });
});

describe("CRM listener", () => {
  function contact(overrides: Row = {}) {
    return db.seed("crmContact", { id: "ct1", workspaceId: "w1", instagramAccountId: "w1_a1", igUserId: "u_l1", conversationId: null, ...overrides });
  }

  it("score.becameHot emits lead.hot for the contact's lead", async () => {
    seedLead({ temperature: "HOT" });
    const row = contact();
    await handleCrmEvent({
      kind: "score", workspaceId: "w1", contactId: "ct1", contact: row as never, score: 70, previousScore: 20,
      temperature: "HOT", previousTemperature: "COLD", becameHot: true,
    } as CrmEvent);
    expect(rows("outboundEvent").map((e) => e.dedupeKey)).toEqual(["lead.hot:l1"]);
  });

  it("score without becameHot, or without a lead yet, emits nothing", async () => {
    const row = contact();
    const base = { kind: "score", workspaceId: "w1", contactId: "ct1", contact: row as never, score: 70, previousScore: 60, temperature: "HOT", previousTemperature: "HOT" };
    await handleCrmEvent({ ...base, becameHot: false } as CrmEvent);
    await handleCrmEvent({ ...base, becameHot: true } as CrmEvent);
    expect(rows("outboundEvent")).toHaveLength(0);
  });

  it("stage_changed emits deal.stage_changed with the previous stage as a hint", async () => {
    const row = contact();
    db.seed("crmDeal", { id: "d1", workspaceId: "w1", contactId: "ct1", pipelineId: "p1", stageId: "s2", title: "Deal" });
    await handleCrmEvent({
      kind: "stage_changed", workspaceId: "w1", contactId: "ct1", contact: row as never, dealId: "d1",
      fromStageId: "s1", toStageId: "s2", stageKind: "OPEN", actor: { kind: "OPERATOR" },
    } as CrmEvent);
    const event = rows("outboundEvent")[0];
    expect(event).toMatchObject({ type: "deal.stage_changed", subjectType: "deal", subjectId: "d1" });
    expect((event.payload as Row).hint).toEqual({ fromStageId: "s1" });
    expect(String(event.dedupeKey)).toContain("deal.stage_changed:d1:s2:");
  });

  it("deal.stage_changed payload carries the stage names and the previous stage", async () => {
    contact();
    db.seed("crmPipeline", { id: "p1", workspaceId: "w1", name: "Sotuv" });
    db.seed("crmStage", { id: "s1", pipelineId: "p1", name: "Yangi", sort: 1 });
    db.seed("crmStage", { id: "s2", pipelineId: "p1", name: "Taklif", sort: 2 });
    db.seed("crmDeal", { id: "d1", workspaceId: "w1", contactId: "ct1", pipelineId: "p1", stageId: "s2", title: "Deal" });
    const hook = seedWebhook();
    seedSubscription(hook.id as string, "deal.stage_changed");
    const id = (await emitOutbound({
      workspaceId: "w1", type: "deal.stage_changed", subjectType: "deal", subjectId: "d1", instagramAccountId: "w1_a1",
      payload: { fromStageId: "s1" }, dedupeKey: "deal.stage_changed:d1:s2:x",
    }))!;
    await materializeEvent(id);
    const payload = rows("outboundEvent")[0].payload as Row;
    expect(payload.deal).toMatchObject({ pipeline: "Sotuv", stage: "Taklif", from_stage: "Yangi" });
    expect(rows("outboundDelivery")).toHaveLength(1);
  });
});
