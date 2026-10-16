/**
 * ETAP 6 — the seams: `fl:` payloads in the trigger engine, the publish
 * transaction and its gating (proxy campaign, version retirement, AI approval),
 * the pure wait/consume rules and the Runs tab queries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import { forgetCommentClaims } from "@/lib/triggers/claim";
import { forgetAccountGate } from "@/lib/triggers/ingest";
import { normalizeWebhookPayload } from "@/lib/triggers/normalize";
import { FLOW_PAYLOAD_PREFIX, isFlowPayload, parseFlowPayload } from "@/lib/flows/bridge";
import { archiveFlow, publishFlowVersion, PUBLISH_ERRORS, unpublishFlow } from "@/lib/flows/publish";
import { cancelRun, flowStats, getRun, listRuns } from "@/lib/flows/runs";
import { consumesPlainText, extractByCode, isLiveRun, isWindowOpenAt, planSignal, type FlowRunState } from "@/lib/flows/runner";
import { buildIndex } from "@/lib/flows/graph";
import { findStarterTemplate } from "@/lib/flows/templates";
import type { FlowGraph } from "@/lib/flows/schema";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model);
const IG_ID = "17841400000000001";

const t1 = (): FlowGraph => structuredClone(findStarterTemplate("comment_price_lead")!.graph);

function seedDraft(graph: FlowGraph, opts: { source?: string; testedAt?: Date | null; approvedAt?: Date | null; id?: string; flowId?: string } = {}) {
  const flowId = opts.flowId ?? "flow1";
  if (!rows("flow").some((f) => f.id === flowId)) {
    db.seed("flow", { id: flowId, workspaceId: "ws1", instagramAccountId: "acc1", name: "Narx oqimi", triggerType: "COMMENT", status: "DRAFT" });
  }
  const id = opts.id ?? `v${rows("flowVersion").length + 1}`;
  db.seed("flowVersion", {
    id,
    flowId,
    version: rows("flowVersion").filter((v) => v.flowId === flowId).length + 1,
    graph,
    hash: `h-${id}`,
    source: opts.source ?? "MANUAL",
    testedAt: opts.testedAt ?? null,
    approvedAt: opts.approvedAt ?? null,
  });
  return id;
}

beforeEach(() => {
  resetDb();
  forgetAccountGate();
  forgetCommentClaims();
  vi.stubEnv("FLOWS_DISABLED", "");
  db.seed("workspace", { id: "ws1", name: "Test" });
  db.seed("workspace", { id: "ws2", name: "Boshqa" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: "ws1", instagramId: IG_ID, username: "dokon", accessToken: "enc" });
});
afterEach(() => vi.unstubAllEnvs());

describe("fl: payloads", () => {
  it("parse back to run / node / button", () => {
    expect(FLOW_PAYLOAD_PREFIX).toBe("fl:");
    expect(parseFlowPayload("fl:run1:m1:open")).toEqual({ runId: "run1", nodeId: "m1", buttonId: "open" });
    expect(parseFlowPayload("fl:run1:b:a:b")).toEqual({ runId: "run1", nodeId: "b", buttonId: "a:b" });
    expect(parseFlowPayload("fl:run1:m1")).toBeNull();
    expect(parseFlowPayload("c2:e:open")).toBeNull();
    expect(parseFlowPayload(null)).toBeNull();
  });

  it("the normaliser accepts fl: postbacks and quick replies like c2:, and still drops other postbacks", () => {
    const envelope = (item: Record<string, unknown>) => ({
      object: "instagram",
      entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: "u1" }, recipient: { id: IG_ID }, timestamp: Date.now(), ...item }] }],
    });
    const tapped = normalizeWebhookPayload(envelope({ postback: { mid: "pb1", title: "Narxni ko'rish", payload: "fl:r1:m1:open" } }) as never);
    expect(tapped).toHaveLength(1);
    expect(tapped[0]).toMatchObject({ type: "DIRECT_MESSAGE", payload: "fl:r1:m1:open", text: "Narxni ko'rish" });

    const chip = normalizeWebhookPayload(envelope({ message: { mid: "m1", text: "+998901234567", quick_reply: { payload: "fl:r1:b1:ph" } } }) as never);
    expect(chip[0]).toMatchObject({ type: "DIRECT_MESSAGE", payload: "fl:r1:b1:ph", text: "+998901234567" });

    expect(normalizeWebhookPayload(envelope({ postback: { mid: "pb2", title: "x", payload: "reveal:abc" } }) as never)).toHaveLength(0);
    expect(normalizeWebhookPayload(envelope({ postback: { mid: "pb3", title: "x", payload: "c2:e1:open" } }) as never)).toHaveLength(1);

    vi.stubEnv("FLOWS_DISABLED", "1");
    expect(isFlowPayload("fl:r1:m1:open")).toBe(false);
    expect(normalizeWebhookPayload(envelope({ postback: { mid: "pb4", title: "x", payload: "fl:r1:m1:open" } }) as never)).toHaveLength(0);
  });
});

describe("publishFlowVersion", () => {
  it("publishes a MANUAL version: proxy campaign copied 1:1 from the trigger node, flow PUBLISHED", async () => {
    const versionId = seedDraft(t1());
    const result = await publishFlowVersion("ws1", "flow1", versionId, { userId: "u1" });
    expect(result).toMatchObject({ ok: true, flow: { status: "PUBLISHED", publishedVersionId: versionId } });

    const proxy = rows("triggerCampaign")[0];
    expect(proxy).toMatchObject({
      kind: "FLOW",
      active: true,
      workspaceId: "ws1",
      instagramAccountId: "acc1",
      name: "[Flow] Narx oqimi",
      triggerType: "COMMENT",
      matchingMode: "CONTAINS",
      keywords: ["narx", "narxi", "price", "цена"],
      intents: ["PRICE"],
      mediaScope: "ANY",
      priority: 0,
      responseMessage: "(flow)",
      openingButtonLabel: null,
      publicReplyEnabled: false,
      stopOnReply: false,
    });
    expect(rows("flow")[0].proxyCampaignId).toBe(proxy.id);
    expect(rows("flowVersion")[0]).toMatchObject({ publishedByUserId: "u1", retiredAt: null });
    expect(rows("flowVersion")[0].publishedAt).toBeInstanceOf(Date);
  });

  it("a second publish updates the same proxy row and retires the previous version", async () => {
    const v1 = seedDraft(t1());
    await publishFlowVersion("ws1", "flow1", v1, { userId: "u1" });
    const changed = t1();
    const trigger = changed.nodes.find((n) => n.type === "trigger")!;
    if (trigger.type === "trigger") {
      trigger.keywords = ["qancha"];
      trigger.priority = 7;
    }
    const v2 = seedDraft(changed);
    const result = await publishFlowVersion("ws1", "flow1", v2, { userId: "u2" });
    expect(result.ok).toBe(true);
    expect(rows("triggerCampaign")).toHaveLength(1);
    expect(rows("triggerCampaign")[0]).toMatchObject({ keywords: ["qancha"], priority: 7, active: true });
    const [first, second] = rows("flowVersion");
    expect(first.retiredAt).toBeInstanceOf(Date);
    expect(second).toMatchObject({ retiredAt: null, publishedByUserId: "u2" });
    expect(rows("flow")[0].publishedVersionId).toBe(v2);
  });

  it("refuses a version with audit errors (an unknown variable)", async () => {
    const graph = t1();
    const m2 = graph.nodes.find((n) => n.id === "m2")!;
    if (m2.type === "message") m2.text = "Narx: {{vars.yoq_bunday}} so'm";
    const versionId = seedDraft(graph);
    const result = await publishFlowVersion("ws1", "flow1", versionId, { userId: "u1" });
    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(rows("triggerCampaign")).toHaveLength(0);
    expect(rows("flow")[0].status).toBe("DRAFT");
  });

  it("refuses a BLOCKED policy (seven chained messages), an incomplete graph and a foreign version", async () => {
    const chain = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `m${n}`, type: "message" as const, text: `Xabar ${n}`, typingDelayMs: 0 }));
    const graph: FlowGraph = {
      v: 1,
      variables: [],
      nodes: [
        { id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY", keywords: [], intents: [], mediaScope: "ANY", mediaIds: [], storyScope: "ALL", storyIds: [], audience: "ANY", reopenAfterHours: 72, cooldownHours: 24, sourceFilter: "ANY", adIds: [], refs: [], priority: 0 },
        ...chain,
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "t", to: "m1", handle: "next" },
        ...chain.slice(0, -1).map((n, i) => ({ from: n.id, to: chain[i + 1].id, handle: "next" })),
        { from: "m7", to: "end", handle: "next" },
      ],
    };
    const spam = await publishFlowVersion("ws1", "flow1", seedDraft(graph), { userId: "u1" });
    expect(spam).toMatchObject({ ok: false, status: 422 });

    const incomplete = await publishFlowVersion("ws1", "flow1", seedDraft({ ...t1(), edges: [] }), { userId: "u1" });
    expect(incomplete).toMatchObject({ ok: false, status: 422 });
    expect((incomplete as { error: string }).error).toContain("Graf to'liq emas");

    db.seed("flow", { id: "flow2", workspaceId: "ws2", instagramAccountId: "acc1", name: "Boshqa", triggerType: "COMMENT", status: "DRAFT" });
    const foreign = seedDraft(t1(), { flowId: "flow2", id: "vForeign" });
    expect(await publishFlowVersion("ws1", "flow2", foreign, { userId: "u1" })).toMatchObject({ ok: false, status: 404 });
    expect(await publishFlowVersion("ws1", "flow1", foreign, { userId: "u1" })).toMatchObject({ ok: false, status: 404 });
    expect(await publishFlowVersion("ws1", "nope", foreign, { userId: "u1" })).toMatchObject({ ok: false, status: 404 });
    expect(rows("triggerCampaign")).toHaveLength(0);
  });

  it("an AI version needs the test AND the approval; MANUAL and TEMPLATE versions do not", async () => {
    const ai = seedDraft(t1(), { source: "AI" });
    expect(await publishFlowVersion("ws1", "flow1", ai, { userId: "u1" })).toEqual({ ok: false, status: 422, error: PUBLISH_ERRORS.aiNotTested });

    rows("flowVersion").find((v) => v.id === ai)!.testedAt = new Date();
    expect(await publishFlowVersion("ws1", "flow1", ai, { userId: "u1" })).toEqual({ ok: false, status: 422, error: PUBLISH_ERRORS.aiNotApproved });

    rows("flowVersion").find((v) => v.id === ai)!.approvedAt = new Date();
    expect(await publishFlowVersion("ws1", "flow1", ai, { userId: "u1" })).toMatchObject({ ok: true });

    db.seed("flow", { id: "flow3", workspaceId: "ws1", instagramAccountId: "acc1", name: "Shablon", triggerType: "COMMENT", status: "DRAFT" });
    const template = seedDraft(t1(), { source: "TEMPLATE", flowId: "flow3" });
    expect(await publishFlowVersion("ws1", "flow3", template, { userId: "u1" })).toMatchObject({ ok: true });
  });

  it("is refused for an archived flow and with FLOWS_DISABLED=1", async () => {
    const versionId = seedDraft(t1());
    vi.stubEnv("FLOWS_DISABLED", "1");
    expect(await publishFlowVersion("ws1", "flow1", versionId, { userId: "u1" })).toMatchObject({ ok: false, status: 503 });
    vi.stubEnv("FLOWS_DISABLED", "");
    rows("flow")[0].status = "ARCHIVED";
    expect(await publishFlowVersion("ws1", "flow1", versionId, { userId: "u1" })).toMatchObject({ ok: false, status: 409 });
  });
});

describe("unpublish and archive", () => {
  it("switch the proxy campaign off; waiting runs are left to the sweep", async () => {
    const versionId = seedDraft(t1());
    await publishFlowVersion("ws1", "flow1", versionId, { userId: "u1" });
    db.seed("flowRun", { id: "run1", workspaceId: "ws1", flowId: "flow1", versionId, instagramAccountId: "acc1", igUserId: "u", eventId: "e", status: "WAITING_TAP" });

    const off = await unpublishFlow("ws1", "flow1");
    expect(off).toMatchObject({ ok: true, flow: { status: "DRAFT", publishedVersionId: null } });
    expect(rows("triggerCampaign")[0].active).toBe(false);
    expect(rows("flowVersion")[0].retiredAt).toBeInstanceOf(Date);
    expect(rows("flowRun")[0].status).toBe("WAITING_TAP");

    await publishFlowVersion("ws1", "flow1", versionId, { userId: "u1" });
    expect(rows("triggerCampaign")[0].active).toBe(true);
    const archived = await archiveFlow("ws1", "flow1");
    expect(archived).toMatchObject({ ok: true, flow: { status: "ARCHIVED" } });
    expect((archived as { flow: Row }).flow.archivedAt).toBeInstanceOf(Date);
    expect(rows("triggerCampaign")[0].active).toBe(false);

    expect(await unpublishFlow("ws2", "flow1")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("wait / consume rules (pure)", () => {
  const run = (patch: Partial<FlowRunState>): FlowRunState => ({
    id: "r", status: "WAITING_TAP", triggerType: "DIRECT_MESSAGE", currentNodeId: "b", seq: 3, vars: {}, waitNodeId: "b", waitKind: "choice",
    waitUntil: null, sendsSinceInbound: 0, startedAt: new Date(), endReason: null, lastError: null, isTest: false, ...patch,
  });
  const graph = {
    v: 1 as const,
    variables: [],
    nodes: [
      { id: "t", type: "trigger" as const, triggerType: "DIRECT_MESSAGE" as const, matchingMode: "EVERY" as const, keywords: [], intents: [], mediaScope: "ANY" as const, mediaIds: [], storyScope: "ALL" as const, storyIds: [], audience: "ANY" as const, reopenAfterHours: 72, cooldownHours: 24, sourceFilter: "ANY" as const, adIds: [], refs: [], priority: 0 },
      { id: "b", type: "button" as const, text: "Tanlang", onText: "keep_waiting" as const, buttons: [{ id: "x", label: "Katalog", kind: "text" as const }, { id: "p", label: "Raqam", kind: "phone" as const }] },
      { id: "m", type: "message" as const, text: "Salom", typingDelayMs: 0, button: { id: "open", label: "Ochish" } },
    ],
    edges: [],
  };
  const index = buildIndex(graph);
  const now = new Date();
  const at = new Date();

  it("which runs take a plain typed message", () => {
    expect(consumesPlainText({ status: "WAITING_INBOUND", waitKind: "inbound" })).toBe(true);
    expect(consumesPlainText({ status: "WAITING_TAP", waitKind: "choice" })).toBe(true);
    expect(consumesPlainText({ status: "WAITING_TAP", waitKind: "phone" })).toBe(true);
    expect(consumesPlainText({ status: "ACTIVE", waitKind: null })).toBe(true);
    expect(consumesPlainText({ status: "WAITING_TAP", waitKind: "tap" })).toBe(false);
    expect(consumesPlainText({ status: "WAITING_DELAY", waitKind: "delay" })).toBe(false);
    expect(consumesPlainText({ status: "DONE", waitKind: null })).toBe(false);
    expect(isLiveRun({ status: "WAITING_DELAY" })).toBe(true);
    expect(isLiveRun({ status: "CANCELLED" })).toBe(false);
  });

  it("planSignal: taps must match the waiting node and button", () => {
    const tap = (nodeId: string, buttonId: string, text = "") => ({ kind: "tap" as const, nodeId, buttonId, eventId: "e", at, text });
    expect(planSignal(run({}), index, tap("b", "x"), now)).toEqual({ kind: "apply" });
    expect(planSignal(run({}), index, tap("b", "zzz"), now)).toMatchObject({ kind: "ignore" });
    expect(planSignal(run({}), index, tap("m", "open"), now)).toMatchObject({ kind: "ignore", touch: true });
    // a phone chip needs a number
    expect(planSignal(run({ waitKind: "phone" }), index, tap("b", "p", "salom"), now)).toMatchObject({ kind: "ignore" });
    expect(planSignal(run({ waitKind: "phone" }), index, tap("b", "p", "+998 90 123 45 67"), now)).toEqual({ kind: "apply" });
    // a finished run ignores everything
    expect(planSignal(run({ status: "DONE" }), index, tap("b", "x"), now)).toMatchObject({ kind: "ignore" });
    // a message button
    expect(planSignal(run({ waitNodeId: "m", currentNodeId: "m", waitKind: "tap" }), index, tap("m", "open"), now)).toEqual({ kind: "apply" });
  });

  it("planSignal: typed text — keep_waiting ignores it, a typed phone satisfies the phone chip, timers need their time", () => {
    const text = (value: string) => ({ kind: "inbound" as const, text: value, eventId: "e", at });
    expect(planSignal(run({}), index, text("salom"), now)).toMatchObject({ kind: "ignore", touch: true });
    expect(planSignal(run({}), index, text("901234567"), now)).toEqual({ kind: "apply" });
    expect(planSignal(run({ waitNodeId: "m", currentNodeId: "m", waitKind: "tap" }), index, text("salom"), now)).toMatchObject({ kind: "ignore" });
    expect(planSignal(run({ status: "WAITING_DELAY", waitKind: "delay", waitUntil: new Date(now.getTime() + 1000) }), index, { kind: "timer" }, now)).toMatchObject({ kind: "ignore" });
    expect(planSignal(run({ status: "WAITING_DELAY", waitKind: "delay", waitUntil: new Date(now.getTime() - 1000) }), index, { kind: "timer" }, now)).toEqual({ kind: "apply" });
    expect(planSignal(run({ status: "WAITING_INBOUND", waitKind: "inbound", waitNodeId: "b" }), index, text("javob"), now)).toEqual({ kind: "apply" });
  });

  it("the 24h window rule matches followups.isWindowOpen (24h minus 5 minutes)", () => {
    const anchor = new Date("2026-03-02T10:00:00Z");
    expect(isWindowOpenAt({ openedAt: null, lastInboundAt: null }, anchor)).toBe(false);
    expect(isWindowOpenAt({ openedAt: anchor, lastInboundAt: null }, new Date(anchor.getTime() + 23 * 3600_000))).toBe(true);
    expect(isWindowOpenAt({ openedAt: anchor, lastInboundAt: null }, new Date(anchor.getTime() + 24 * 3600_000 - 4 * 60_000))).toBe(false);
    expect(isWindowOpenAt({ openedAt: anchor, lastInboundAt: new Date(anchor.getTime() + 20 * 3600_000) }, new Date(anchor.getTime() + 40 * 3600_000))).toBe(true);
  });

  it("answers are extracted by code where possible", () => {
    expect(extractByCode("phone", "raqamim 90 123 45 67 edi")).toBe("+998901234567");
    expect(extractByCode("phone", "bilmayman")).toBeNull();
    expect(extractByCode("email", "Mening pochtam Ali@Mail.uz")).toBe("ali@mail.uz");
    expect(extractByCode("number", "2,5 kg")).toBe("2.5");
    expect(extractByCode("yes_no", "Ha")).toBe("ha");
    expect(extractByCode("yes_no", "yo'q rahmat")).toBe("yo'q");
    expect(extractByCode("yes_no", "balki")).toBeNull();
    expect(extractByCode("name", "Ali")).toBeUndefined(); // needs the model
    expect(extractByCode(undefined, "  istalgan matn ")).toBe("istalgan matn");
  });
});

describe("Runs tab queries", () => {
  function seedRuns() {
    db.seed("flow", { id: "flow1", workspaceId: "ws1", instagramAccountId: "acc1", name: "Narx oqimi", triggerType: "COMMENT" });
    db.seed("flowVersion", { id: "v1", flowId: "flow1", version: 1, graph: {}, hash: "h" });
    const base = { workspaceId: "ws1", flowId: "flow1", versionId: "v1", instagramAccountId: "acc1", eventId: "e" };
    const startedAt = (n: number) => new Date(Date.UTC(2026, 2, 1, 10, n));
    db.seed("flowRun", { ...base, id: "r1", igUserId: "u1", status: "DONE", startedAt: startedAt(1), variables: { phone: "+998901234567", __acq: "x" } });
    db.seed("flowRun", { ...base, id: "r2", igUserId: "u2", status: "WAITING_TAP", startedAt: startedAt(2) });
    db.seed("flowRun", { ...base, id: "r3", igUserId: "u3", status: "FAILED", startedAt: startedAt(3) });
    db.seed("flowRun", { ...base, id: "r4", workspaceId: "ws2", igUserId: "u4", status: "DONE", startedAt: startedAt(4) });
    const step = (runId: string, seq: number, nodeId: string, status: string) =>
      db.seed("flowRunStep", { runId, seq, nodeId, nodeType: "message", status });
    step("r1", 1, "t", "DONE");
    step("r1", 2, "m1", "DONE");
    step("r2", 1, "t", "DONE");
    step("r2", 2, "m1", "WAITING");
    step("r3", 1, "t", "DONE");
    step("r3", 2, "m1", "FAILED");
  }

  it("lists newest first, filters by status and pages with a cursor, workspace scoped", async () => {
    seedRuns();
    const all = await listRuns("ws1", { flowId: "flow1" });
    expect(all.runs.map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect(all.runs[0]).toMatchObject({ flowName: "Narx oqimi", version: 1 });
    expect("variables" in all.runs[0]).toBe(false);
    const failed = await listRuns("ws1", { status: "FAILED" });
    expect(failed.runs.map((r) => r.id)).toEqual(["r3"]);
    const page1 = await listRuns("ws1", { limit: 2 });
    expect(page1.runs.map((r) => r.id)).toEqual(["r3", "r2"]);
    expect(page1.nextCursor).toBe("r2");
    const page2 = await listRuns("ws1", { limit: 2, cursor: page1.nextCursor! });
    expect(page2.runs.map((r) => r.id)).toEqual(["r1"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("shows one run with its steps and without internal variables; another workspace's run is 404", async () => {
    seedRuns();
    const run = await getRun("ws1", "r1");
    expect(run.steps.map((s) => s.nodeId)).toEqual(["t", "m1"]);
    expect(run.variables).toEqual({ phone: "+998901234567" });
    expect(run.flowName).toBe("Narx oqimi");
    await expect(getRun("ws1", "r4")).rejects.toMatchObject({ status: 404 });
    await expect(getRun("ws1", "nope")).rejects.toMatchObject({ status: 404 });
  });

  it("cancels a live run once; finished and foreign runs are untouched", async () => {
    seedRuns();
    expect(await cancelRun("ws1", "r2", "Qo'lda")).toMatchObject({ status: "CANCELLED", alreadyFinished: false });
    expect(rows("flowRun").find((r) => r.id === "r2")).toMatchObject({ status: "CANCELLED", endReason: "Qo'lda", waitKind: null });
    expect(await cancelRun("ws1", "r2")).toMatchObject({ alreadyFinished: true });
    expect(await cancelRun("ws1", "r1")).toMatchObject({ status: "DONE", alreadyFinished: true });
    await expect(cancelRun("ws1", "r4")).rejects.toMatchObject({ status: 404 });
  });

  it("statistics: runs by status, visits per node, completion rate", async () => {
    seedRuns();
    const stats = await flowStats("ws1", "flow1");
    expect(stats).toMatchObject({ total: 3, byStatus: { DONE: 1, WAITING_TAP: 1, FAILED: 1 }, completionRate: 0.5, truncated: false });
    expect(stats.nodes).toEqual([
      { nodeId: "m1", nodeType: "message", visits: 3, failed: 1, skipped: 0 },
      { nodeId: "t", nodeType: "message", visits: 3, failed: 0, skipped: 0 },
    ]);
    await expect(flowStats("ws2", "flow1")).rejects.toMatchObject({ status: 404 });
  });
});
