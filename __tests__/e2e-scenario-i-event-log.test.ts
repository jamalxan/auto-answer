/**
 * Scenario I (event log): through the webhook ingest path a DM, a story reply
 * and a mention each leave exactly one trigger log row (IGNORED with a reason
 * when no automation answers), a redelivery is not logged twice, and the
 * Foundation diagnostics "last event" is computed from ALL event types and is
 * fresh right after the events.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/triggers/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/triggers/queue")>()),
  enqueueEvent: vi.fn().mockResolvedValue(undefined),
}));

import { forgetAccountGate, ingestWebhookPayload } from "@/lib/triggers/ingest";
import { runDiagnostics } from "@/lib/foundation/diagnostics";

const IG = "17841400000000001";

function payload(entry: Record<string, unknown>) {
  return { object: "instagram", entry: [{ id: IG, time: Date.now(), ...entry }] };
}

const ts = () => Date.now();

const dm = (mid = "m.dm") =>
  payload({ messaging: [{ sender: { id: "u1" }, recipient: { id: IG }, timestamp: ts(), message: { mid, text: "salom" } }] });
const storyReply = (mid = "m.sr") =>
  payload({ messaging: [{ sender: { id: "u2" }, recipient: { id: IG }, timestamp: ts(), message: { mid, text: "narx?", reply_to: { story: { id: "s1", url: "https://cdn/s.jpg" } } } }] });
const storyMention = (mid = "m.sm") =>
  payload({
    messaging: [{ sender: { id: "u3" }, recipient: { id: IG }, timestamp: ts(), message: { mid, attachments: [{ type: "story_mention", payload: { url: "https://cdn/m.jpg" } }] } }],
  });
const mentionField = () => payload({ changes: [{ field: "mentions", value: { media_id: "p9", comment_id: "mc1" } }] });

const cases: Array<[string, string, () => ReturnType<typeof payload>]> = [
  ["DIRECT_MESSAGE", "direct message", dm],
  ["STORY_REPLY", "story reply", storyReply],
  ["STORY_MENTION", "story mention", storyMention],
  ["OTHER", "mentions webhook field", mentionField],
];

const rows = () => db.rows("instagramEvent");

beforeEach(() => {
  resetDb();
  forgetAccountGate();
  vi.unstubAllEnvs();
  vi.stubEnv("TRIGGER_ENGINE_DISABLED", "");
  db.seed("workspace", { id: "ws1", name: "T" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: "ws1", instagramId: IG, username: "shop", accessToken: "x", tokenStatus: "ACTIVE", webhookSubscribed: true });
});

async function lastEventItem() {
  const items = await runDiagnostics("ws1", { connections: [], worker: null, queue: undefined }, new Date());
  const item = items.find((i) => i.key === "last_event");
  if (!item) throw new Error("no last_event item");
  return item;
}

describe("Scenario I: one log row per event, IGNORED with a reason", () => {
  it.each(cases)("%s (%s): one IGNORED row with a reason, no automation queue", async (type, _label, make) => {
    const result = await ingestWebhookPayload(make());
    expect(result).toMatchObject({ stored: [], logged: 1 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ eventType: type, processingStatus: "IGNORED", claimedCampaignId: null, workspaceId: "ws1", instagramAccountId: "acc1" });
    expect(String(rows()[0].error).length).toBeGreaterThan(0);
  });

  it("DM, story reply and mention together produce exactly three rows", async () => {
    await ingestWebhookPayload(dm());
    await ingestWebhookPayload(storyReply());
    await ingestWebhookPayload(storyMention());
    expect(rows().map((r) => r.eventType).sort()).toEqual(["DIRECT_MESSAGE", "STORY_MENTION", "STORY_REPLY"]);
    expect(rows().every((r) => r.processingStatus === "IGNORED" && r.error)).toBe(true);
  });

  it.each(cases)("%s redelivery is not logged twice", async (_type, _label, make) => {
    const body = make();
    await ingestWebhookPayload(body);
    const again = await ingestWebhookPayload(body);
    expect(again.duplicates).toBe(1);
    expect(again.logged).toBe(0);
    expect(rows()).toHaveLength(1);
  });

  it("two events of one payload are both logged once", async () => {
    const body = { object: "instagram", entry: [{ id: IG, time: Date.now(), messaging: [
      { sender: { id: "u1" }, recipient: { id: IG }, timestamp: ts(), message: { mid: "a1", text: "bir" } },
      { sender: { id: "u1" }, recipient: { id: IG }, timestamp: ts(), message: { mid: "a2", text: "ikki" } },
    ] }] };
    expect((await ingestWebhookPayload(body)).logged).toBe(2);
    expect((await ingestWebhookPayload(body)).duplicates).toBe(2);
    expect(rows()).toHaveLength(2);
  });
});

describe("Scenario I: Foundation diagnostics last event covers all event types", () => {
  it("is unknown with no events and no live account", async () => {
    const item = await lastEventItem();
    expect(item.status).toBe("unknown"); // no accounts passed -> no live account; nothing received
  });

  it.each(cases)("a lone %s event makes last_event fresh (under a minute)", async (_type, _label, make) => {
    // the webhook delivery log is empty/old; only the trigger log row is new
    db.seed("webhookEvent", { workspaceId: "ws1", status: "PROCESSED", createdAt: new Date(Date.now() - 5 * 24 * 3600_000) });
    await ingestWebhookPayload(make());
    const item = await lastEventItem();
    const ageMs = Date.now() - new Date(item.lastCheck as string).getTime();
    expect(Math.abs(ageMs)).toBeLessThan(60_000);
    expect(item.status).toBe("ok");
    expect(item.issue).toBeNull();
  });

  it("with all three events the newest one wins over an old webhook row", async () => {
    db.seed("webhookEvent", { workspaceId: "ws1", status: "PROCESSED", createdAt: new Date(Date.now() - 10 * 24 * 3600_000) });
    await ingestWebhookPayload(dm());
    await ingestWebhookPayload(storyReply());
    await ingestWebhookPayload(storyMention());
    const newest = Math.max(...rows().map((r) => (r.createdAt as Date).getTime()));
    const item = await lastEventItem();
    expect(new Date(item.lastCheck as string).getTime()).toBe(newest);
    expect(Math.abs(Date.now() - newest)).toBeLessThan(60_000);
  });
});
