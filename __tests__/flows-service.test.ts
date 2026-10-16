/**
 * ETAP 6/7 — the Flow DB layer against the in-memory db: create (blank /
 * template / graph / AI), draft save + hash + reset of testedAt / approvedAt,
 * audit storage, approve and publish gating (the engine side is mocked),
 * versions + diff, templates, workspace scoping, deleteFlow rules.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  publishFlowVersion: vi.fn(),
  unpublishFlow: vi.fn(),
  archiveFlow: vi.fn(),
  runFlowSandbox: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/flows/publish", () => ({
  publishFlowVersion: mocks.publishFlowVersion,
  unpublishFlow: mocks.unpublishFlow,
  archiveFlow: mocks.archiveFlow,
}));
vi.mock("@/lib/flows/sandbox", () => ({ runFlowSandbox: mocks.runFlowSandbox }));

import { setLlmProviderForTests } from "../lib/assistant/llm/provider";
import { hashGraph } from "../lib/flows/canonical";
import { flowGraphDraftSchema, type FlowGraph } from "../lib/flows/schema";
import {
  approveVersion,
  archive,
  createFlow,
  deleteFlow,
  deleteTemplate,
  diffVersions,
  getFlow,
  getVersion,
  listFlows,
  listTemplates,
  listVersions,
  meta,
  publishVersion,
  renameFlow,
  restoreVersion,
  run,
  runAudit,
  saveAsTemplate,
  saveDraft,
  testVersion,
  unpublish,
} from "../lib/flows/service";
import { FLOW_STARTER_TEMPLATES, findStarterTemplate } from "../lib/flows/templates";

const WS = "w1";
const OTHER = "w2";
const T1 = "comment_price_lead";

const rowsOf = (model: string) => db.rows(model);
const flowRow = (id: string) => rowsOf("flow").find((r) => r.id === id)!;
const versionRow = (id: string) => rowsOf("flowVersion").find((r) => r.id === id)!;

function seed() {
  db.seed("workspace", { id: WS, ownerId: "u1", name: "Mebel" });
  db.seed("workspace", { id: OTHER, ownerId: "u2", name: "Boshqa" });
  db.seed("instagramAccount", { id: "a1", workspaceId: WS, username: "mebel", instagramId: "ig1" });
  db.seed("instagramAccount", { id: "a2", workspaceId: OTHER, username: "boshqa", instagramId: "ig2" });
}

async function newFlow(over: Record<string, unknown> = {}) {
  return createFlow(WS, { instagramAccountId: "a1", fromTemplateKey: T1, ...over }, { userId: "u1" });
}

function withEdited(graph: FlowGraph, text: string): FlowGraph {
  const copy = structuredClone(graph);
  const message = copy.nodes.find((n) => n.type === "message");
  if (message && message.type === "message") message.text = text;
  return copy;
}

beforeEach(() => {
  resetDb();
  seed();
  setLlmProviderForTests(undefined);
  delete process.env.FLOWS_DISABLED;
  mocks.publishFlowVersion.mockReset().mockResolvedValue({ ok: true, flow: { id: "published" } });
  mocks.unpublishFlow.mockReset().mockResolvedValue({ ok: true });
  mocks.archiveFlow.mockReset().mockResolvedValue({ ok: true });
  mocks.runFlowSandbox.mockReset().mockResolvedValue({ steps: [], sends: [], status: "DONE", endedAt: "end", variables: {}, policyVerdict: "PASS", warnings: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createFlow", () => {
  it("copies a starter template: flow + draft v1 (source TEMPLATE) with stored audit, policy and hash", async () => {
    const created = await newFlow();
    expect(created.flow).toMatchObject({ workspaceId: WS, instagramAccountId: "a1", status: "DRAFT", mode: "SIMPLE", triggerType: "COMMENT" });
    expect(created.flow.name).toBe(findStarterTemplate(T1)!.name);
    expect(rowsOf("flowVersion")).toHaveLength(1);
    const version = versionRow(created.flow.draftVersionId!);
    expect(version).toMatchObject({ version: 1, source: "TEMPLATE", hash: hashGraph(findStarterTemplate(T1)!.graph) });
    expect((version.auditResult as { errors: unknown[] }).errors).toEqual([]);
    expect(["PASS", "WARNING"]).toContain((version.policyResult as { verdict: string }).verdict);
    expect(flowRow(created.flow.id).draftVersionId).toBe(version.id);
    // The template's tags are created in the CRM so the auditor does not flag them.
    for (const slug of findStarterTemplate(T1)!.tags) expect(rowsOf("crmTag").some((t) => t.workspaceId === WS && t.slug === slug)).toBe(true);
  });

  it("creates a blank flow (DM trigger by default, COMMENT blank carries the opening button)", async () => {
    const dm = await createFlow(WS, { name: "Bo'sh", instagramAccountId: "a1", mode: "ADVANCED" });
    expect(dm.flow).toMatchObject({ name: "Bo'sh", mode: "ADVANCED", triggerType: "DIRECT_MESSAGE" });
    expect(versionRow(dm.flow.draftVersionId!).source).toBe("MANUAL");
    const comment = await createFlow(WS, { instagramAccountId: "a1", triggerType: "COMMENT" });
    const graph = flowGraphDraftSchema.parse(versionRow(comment.flow.draftVersionId!).graph);
    expect(graph.nodes.some((n) => n.type === "message" && n.button)).toBe(true);
    expect(comment.evaluation.policy.verdict).not.toBe("BLOCKED");
  });

  it("accepts a ready graph; with a prompt the source is AI", async () => {
    const graph = findStarterTemplate("faq_javobai")!.graph;
    const manual = await createFlow(WS, { name: "Qo'lda", instagramAccountId: "a1", graph });
    expect(versionRow(manual.flow.draftVersionId!).source).toBe("MANUAL");
    const ai = await createFlow(WS, { name: "AI", instagramAccountId: "a1", graph, prompt: "FAQ oqim" });
    expect(versionRow(ai.flow.draftVersionId!)).toMatchObject({ source: "AI", prompt: "FAQ oqim" });
  });

  it("rejects bad input (400), a foreign account (404) and an unknown template (404)", async () => {
    await expect(createFlow(WS, { instagramAccountId: "a1", graph: { v: 1, nodes: [] } })).rejects.toMatchObject({ status: 400 });
    await expect(createFlow(WS, { name: "", instagramAccountId: "a1" })).rejects.toMatchObject({ status: 400 });
    await expect(createFlow(WS, { instagramAccountId: "a2" })).rejects.toMatchObject({ status: 404 });
    await expect(createFlow(WS, { instagramAccountId: "a1", fromTemplateKey: "nope" })).rejects.toMatchObject({ status: 404 });
    await expect(createFlow(WS, { instagramAccountId: "a1", fromTemplateKey: T1, prompt: "x" })).rejects.toMatchObject({ status: 400 });
    expect(rowsOf("flow")).toHaveLength(0);
  });
});

describe("saveDraft", () => {
  it("updates the unpublished draft in place; a changed hash resets testedAt / approvedAt, a layout-only save does not", async () => {
    const { flow } = await newFlow();
    const vid = flow.draftVersionId!;
    const graph = flowGraphDraftSchema.parse(versionRow(vid).graph);
    db.rows("flowVersion").find((r) => r.id === vid)!.testedAt = new Date();
    db.rows("flowVersion").find((r) => r.id === vid)!.approvedAt = new Date();

    const layoutOnly = await saveDraft(WS, flow.id, { graph: { ...graph, layout: { [graph.nodes[0].id]: { x: 5, y: 5 } } } });
    expect(layoutOnly.opened).toBe("updated");
    expect(versionRow(vid).testedAt).toBeTruthy();
    expect(versionRow(vid).approvedAt).toBeTruthy();

    const edited = await saveDraft(WS, flow.id, { graph: withEdited(graph, "Yangi matn {{name}}"), changeNote: "matn" });
    expect(edited.version.id).toBe(vid);
    expect(rowsOf("flowVersion")).toHaveLength(1);
    expect(versionRow(vid)).toMatchObject({ testedAt: null, approvedAt: null, approvedByUserId: null, changeNote: "matn", source: "MANUAL" });
    expect(versionRow(vid).hash).toBe(hashGraph(withEdited(graph, "Yangi matn {{name}}")));
    expect((versionRow(vid).auditResult as { hash: string }).hash).toBe(versionRow(vid).hash);
  });

  it("opens a new version after a publish and keeps the published one untouched", async () => {
    const { flow } = await newFlow();
    const v1 = flow.draftVersionId!;
    const graph = flowGraphDraftSchema.parse(versionRow(v1).graph);
    Object.assign(versionRow(v1), { publishedAt: new Date() });
    Object.assign(flowRow(flow.id), { status: "PUBLISHED", publishedVersionId: v1 });

    const saved = await saveDraft(WS, flow.id, { graph: withEdited(graph, "v2 matni") });
    expect(saved.opened).toBe("new_version");
    expect(saved.version.version).toBe(2);
    expect(rowsOf("flowVersion")).toHaveLength(2);
    expect(versionRow(v1).hash).toBe(hashGraph(graph));
    expect(flowRow(flow.id)).toMatchObject({ draftVersionId: saved.version.id, publishedVersionId: v1, status: "PUBLISHED" });

    // Saving again edits v2 in place.
    const again = await saveDraft(WS, flow.id, { graph: withEdited(graph, "v2 qayta") });
    expect(again.opened).toBe("updated");
    expect(rowsOf("flowVersion")).toHaveLength(2);
  });

  it("an AI version stays AI after a manual edit; a template becomes MANUAL; REVIEW falls back to DRAFT", async () => {
    const graph = findStarterTemplate("faq_javobai")!.graph;
    const ai = await createFlow(WS, { name: "AI", instagramAccountId: "a1", graph, prompt: "FAQ" });
    await saveDraft(WS, ai.flow.id, { graph: withEdited(graph, "boshqa matn") });
    expect(versionRow(ai.flow.draftVersionId!).source).toBe("AI");

    const { flow } = await newFlow();
    const g = flowGraphDraftSchema.parse(versionRow(flow.draftVersionId!).graph);
    Object.assign(flowRow(flow.id), { status: "REVIEW" });
    await saveDraft(WS, flow.id, { graph: withEdited(g, "tahrir") });
    expect(flowRow(flow.id).status).toBe("DRAFT");
  });

  it("validates the graph (400), refuses archived flows (422) and foreign flows (404)", async () => {
    const { flow } = await newFlow();
    await expect(saveDraft(WS, flow.id, { graph: { v: 1, nodes: [{ id: "x", type: "nope" }], edges: [] } })).rejects.toMatchObject({ status: 400 });
    await expect(saveDraft(WS, flow.id, {})).rejects.toMatchObject({ status: 400 });
    await expect(saveDraft(OTHER, flow.id, { graph: findStarterTemplate(T1)!.graph })).rejects.toMatchObject({ status: 404 });
    Object.assign(flowRow(flow.id), { status: "ARCHIVED" });
    await expect(saveDraft(WS, flow.id, { graph: findStarterTemplate(T1)!.graph })).rejects.toMatchObject({ status: 422 });
  });

  it("an incomplete draft is saved, and the audit reports the gaps without throwing", async () => {
    const { flow } = await newFlow();
    const broken = flowGraphDraftSchema.parse({
      v: 1,
      nodes: [
        { id: "t", type: "trigger", triggerType: "COMMENT", matchingMode: "EVERY" },
        { id: "m1", type: "message", text: "Salom", button: { id: "go", label: "Ha" } },
      ],
      edges: [{ from: "t", to: "m1", handle: "next" }],
    });
    const saved = await saveDraft(WS, flow.id, { graph: broken });
    expect(saved.evaluation.audit.errors.length).toBeGreaterThan(0);
    expect(saved.evaluation.publishable).toBe(false);
  });
});

describe("runAudit", () => {
  it("audits the draft by default, stores the result, and flags a COMMENT flow without the opening button as BLOCKED", async () => {
    const { flow } = await newFlow();
    const noButton = flowGraphDraftSchema.parse({
      v: 1,
      nodes: [
        { id: "t", type: "trigger", triggerType: "COMMENT", matchingMode: "EVERY" },
        { id: "m1", type: "message", text: "Salom" },
        { id: "m2", type: "message", text: "Narxlar haqida ma'lumot" },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "t", to: "m1", handle: "next" },
        { from: "m1", to: "m2", handle: "next" },
        { from: "m2", to: "end", handle: "next" },
      ],
    });
    await saveDraft(WS, flow.id, { graph: noButton });
    const result = await runAudit(WS, flow.id);
    expect(result.policy.verdict).toBe("BLOCKED");
    expect(result.publishable).toBe(false);
    expect((versionRow(flow.draftVersionId!).policyResult as { verdict: string }).verdict).toBe("BLOCKED");
    await expect(runAudit(OTHER, flow.id)).rejects.toMatchObject({ status: 404 });
    await expect(runAudit(WS, flow.id, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("testVersion", () => {
  it("marks testedAt on a clean run and not on a failed one", async () => {
    const { flow } = await newFlow();
    const vid = flow.draftVersionId!;
    const bad = await (async () => {
      mocks.runFlowSandbox.mockResolvedValueOnce({ steps: [{ status: "FAILED", error: "boom" }], status: "FAILED" });
      return testVersion(WS, flow.id, vid, { taps: ["open"] });
    })();
    expect(bad.passed).toBe(false);
    expect(versionRow(vid).testedAt).toBeNull();

    const ok = await testVersion(WS, flow.id, vid, { contact: { name: "Ali" }, window: "open", inbound: [{ text: "narx" }] });
    expect(ok.passed).toBe(true);
    expect(versionRow(vid).testedAt).toBeInstanceOf(Date);
    expect(mocks.runFlowSandbox).toHaveBeenLastCalledWith(WS, expect.objectContaining({ v: 1 }), expect.objectContaining({ window: "open" }));
    await expect(testVersion(OTHER, flow.id, vid, {})).rejects.toMatchObject({ status: 404 });
    await expect(testVersion(WS, flow.id, vid, { window: "sideways" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("approveVersion and publishVersion gating", () => {
  async function aiFlow() {
    const graph = findStarterTemplate(T1)!.graph;
    const created = await createFlow(WS, { name: "AI", instagramAccountId: "a1", graph, prompt: "narx oqimi" }, { userId: "u1" });
    return { flow: created.flow, vid: created.flow.draftVersionId! };
  }

  it("AI versions need a passing test before approval; then approval records who and when", async () => {
    const { flow, vid } = await aiFlow();
    await expect(approveVersion(WS, vid, "u1")).rejects.toMatchObject({ status: 422, message: expect.stringContaining("sinab ko'ring") });
    await testVersion(WS, flow.id, vid, {});
    const approved = await approveVersion(WS, vid, "u9");
    expect(approved.approvedAt).toBeInstanceOf(Date);
    expect(versionRow(vid)).toMatchObject({ approvedByUserId: "u9" });
    expect(flowRow(flow.id).status).toBe("REVIEW");
  });

  it("a manual version can be approved without a test, but never with audit errors or a BLOCKED policy", async () => {
    const { flow } = await newFlow();
    await expect(approveVersion(WS, flow.draftVersionId!, "u1")).resolves.toBeTruthy();

    const blocked = await createFlow(WS, {
      name: "Blocked",
      instagramAccountId: "a1",
      graph: {
        v: 1,
        nodes: [
          { id: "t", type: "trigger", triggerType: "COMMENT", matchingMode: "EVERY" },
          { id: "m1", type: "message", text: "Salom" },
          { id: "m2", type: "message", text: "Narxlar haqida ma'lumot" },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "t", to: "m1", handle: "next" },
          { from: "m1", to: "m2", handle: "next" },
          { from: "m2", to: "end", handle: "next" },
        ],
      },
    });
    await expect(approveVersion(WS, blocked.flow.draftVersionId!, "u1")).rejects.toMatchObject({ status: 422 });
  });

  it("approving a foreign or unknown version is 404", async () => {
    const { flow } = await newFlow();
    await expect(approveVersion(OTHER, flow.draftVersionId!, "u1")).rejects.toMatchObject({ status: 404 });
    await expect(approveVersion(WS, "nope", "u1")).rejects.toMatchObject({ status: 404 });
  });

  it("an edit after approval removes the approval, so an AI version cannot be published", async () => {
    const { flow, vid } = await aiFlow();
    await testVersion(WS, flow.id, vid, {});
    await approveVersion(WS, vid, "u1");
    const graph = flowGraphDraftSchema.parse(versionRow(vid).graph);
    await saveDraft(WS, flow.id, { graph: withEdited(graph, "boshqa matn") });
    await expect(publishVersion(WS, flow.id, vid, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 422, message: expect.stringContaining("sinab ko'ring") });
    expect(mocks.publishFlowVersion).not.toHaveBeenCalled();
  });

  it("AI publish needs test then approval; then it calls the engine with the user", async () => {
    const { flow, vid } = await aiFlow();
    await expect(publishVersion(WS, flow.id, vid, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 422 });
    await testVersion(WS, flow.id, vid, {});
    await expect(publishVersion(WS, flow.id, vid, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ message: expect.stringContaining("tasdiqsiz ishga tushmaydi") });
    await approveVersion(WS, vid, "u1");
    const result = await publishVersion(WS, flow.id, vid, { acknowledgeWarnings: true }, "u7");
    expect(result.versionId).toBe(vid);
    expect(mocks.publishFlowVersion).toHaveBeenCalledWith(WS, flow.id, vid, { userId: "u7" });
  });

  it("a manual version publishes without approval but only after a passing test of its current text", async () => {
    const { flow } = await newFlow();
    const vid = flow.draftVersionId!;
    await expect(publishVersion(WS, flow.id, vid, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 422, message: expect.stringContaining("sinab ko'ring") });
    // a failed sandbox run does not count
    mocks.runFlowSandbox.mockResolvedValueOnce({ steps: [{ status: "FAILED", error: "boom" }], status: "FAILED" });
    await testVersion(WS, flow.id, vid, {});
    await expect(publishVersion(WS, flow.id, vid, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 422 });
    await testVersion(WS, flow.id, vid, {});
    // editing after the test removes it again
    const graph = flowGraphDraftSchema.parse(versionRow(vid).graph);
    await saveDraft(WS, flow.id, { graph: withEdited(graph, "boshqa matn") });
    await expect(publishVersion(WS, flow.id, vid, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 422, message: expect.stringContaining("sinab ko'ring") });
    expect(mocks.publishFlowVersion).not.toHaveBeenCalled();
    await testVersion(WS, flow.id, vid, {});
    await expect(publishVersion(WS, flow.id, vid, { acknowledgeWarnings: true }, "u1")).resolves.toBeTruthy();
    expect(mocks.publishFlowVersion).toHaveBeenCalledTimes(1);
  });

  it("BLOCKED never publishes; warnings need acknowledgement", async () => {
    const { flow } = await newFlow();
    const vid = flow.draftVersionId!;
    await testVersion(WS, flow.id, vid, {});
    const verdict = (versionRow(vid).policyResult as { verdict: string }).verdict;
    if (verdict === "WARNING") {
      await expect(publishVersion(WS, flow.id, vid, {}, "u1")).rejects.toMatchObject({ message: expect.stringContaining("Ogohlantirishlar") });
    }
    await expect(publishVersion(WS, flow.id, vid, { acknowledgeWarnings: true }, "u1")).resolves.toBeTruthy();
    expect(mocks.publishFlowVersion).toHaveBeenCalledTimes(1);

    const blocked = await createFlow(WS, {
      name: "Blocked",
      instagramAccountId: "a1",
      graph: {
        v: 1,
        nodes: [
          { id: "t", type: "trigger", triggerType: "COMMENT", matchingMode: "EVERY" },
          { id: "m1", type: "message", text: "Salom" },
          { id: "m2", type: "message", text: "Narxlar haqida ma'lumot" },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "t", to: "m1", handle: "next" },
          { from: "m1", to: "m2", handle: "next" },
          { from: "m2", to: "end", handle: "next" },
        ],
      },
    });
    await testVersion(WS, blocked.flow.id, blocked.flow.draftVersionId!, {});
    await expect(publishVersion(WS, blocked.flow.id, blocked.flow.draftVersionId!, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 422 });
    expect(mocks.publishFlowVersion).toHaveBeenCalledTimes(1);
  });

  it("passes the engine's refusal through with its status; FLOWS_DISABLED blocks publish", async () => {
    const { flow } = await newFlow();
    await testVersion(WS, flow.id, flow.draftVersionId!, {});
    mocks.publishFlowVersion.mockResolvedValueOnce({ ok: false, status: 409, error: "Boshqa oqim band" });
    await expect(publishVersion(WS, flow.id, flow.draftVersionId!, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 409, message: "Boshqa oqim band" });
    process.env.FLOWS_DISABLED = "1";
    await expect(publishVersion(WS, flow.id, flow.draftVersionId!, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 503 });
    expect(await meta(WS)).toMatchObject({ disabled: true });
    delete process.env.FLOWS_DISABLED;
  });

  it("foreign workspace cannot publish", async () => {
    const { flow } = await newFlow();
    await expect(publishVersion(OTHER, flow.id, flow.draftVersionId!, {}, "u1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("unpublish / archive / delete", () => {
  it("unpublish and archive go through the engine; unpublish needs a published flow", async () => {
    const { flow } = await newFlow();
    await expect(unpublish(WS, flow.id)).rejects.toMatchObject({ status: 422 });
    Object.assign(flowRow(flow.id), { status: "PUBLISHED" });
    await unpublish(WS, flow.id, "ARCHIVED");
    expect(mocks.unpublishFlow).toHaveBeenCalledWith(WS, flow.id, "ARCHIVED");
    await archive(WS, flow.id);
    expect(mocks.archiveFlow).toHaveBeenCalledWith(WS, flow.id);
    await expect(archive(OTHER, flow.id)).rejects.toMatchObject({ status: 404 });
  });

  it("deleteFlow: draft without runs is deleted with its versions; published or with runs is 422", async () => {
    const a = await newFlow();
    await expect(deleteFlow(OTHER, a.flow.id)).rejects.toMatchObject({ status: 404 });
    await deleteFlow(WS, a.flow.id);
    expect(rowsOf("flow")).toHaveLength(0);
    expect(rowsOf("flowVersion")).toHaveLength(0);

    const b = await newFlow();
    Object.assign(flowRow(b.flow.id), { status: "PUBLISHED" });
    await expect(deleteFlow(WS, b.flow.id)).rejects.toMatchObject({ status: 422 });

    const c = await newFlow();
    Object.assign(flowRow(c.flow.id), { status: "ARCHIVED" });
    db.seed("flowRun", { workspaceId: WS, flowId: c.flow.id, versionId: c.flow.draftVersionId, status: "DONE", startedAt: new Date() });
    await expect(deleteFlow(WS, c.flow.id)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("tarixi") });
    expect(rowsOf("flow")).toHaveLength(2); // b and c survive
  });
});

describe("listFlows / getFlow", () => {
  it("lists with filters, account username and run stats scoped to the workspace", async () => {
    const a = await newFlow({ name: "A" });
    const b = await newFlow({ name: "B" });
    Object.assign(flowRow(b.flow.id), { status: "PUBLISHED", publishedVersionId: b.flow.draftVersionId });
    Object.assign(versionRow(b.flow.draftVersionId!), { publishedAt: new Date("2026-10-01T00:00:00Z") });
    const other = await createFlow(OTHER, { instagramAccountId: "a2", fromTemplateKey: T1 });
    db.seed("flowRun", { workspaceId: WS, flowId: b.flow.id, versionId: b.flow.draftVersionId, status: "WAITING_TAP", startedAt: new Date() });
    db.seed("flowRun", { workspaceId: WS, flowId: b.flow.id, versionId: b.flow.draftVersionId, status: "DONE", startedAt: new Date() });
    db.seed("flowRun", { workspaceId: WS, flowId: b.flow.id, versionId: b.flow.draftVersionId, status: "DONE", startedAt: new Date(Date.now() - 40 * 86_400_000) });

    const all = await listFlows(WS);
    expect(all.map((f) => f.id).sort()).toEqual([a.flow.id, b.flow.id].sort());
    expect(all.find((f) => f.id === other.flow.id)).toBeUndefined();
    const listed = all.find((f) => f.id === b.flow.id)!;
    expect(listed).toMatchObject({ accountUsername: "mebel", runs30d: 2, activeRuns: 1, publishedVersion: 1, status: "PUBLISHED" });
    expect(listed.lastPublishedAt).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect((await listFlows(WS, { status: "DRAFT" })).map((f) => f.id)).toEqual([a.flow.id]);
    expect(await listFlows(WS, { accountId: "a2" })).toEqual([]);
  });

  it("getFlow returns draft + published summaries and 404 for a foreign flow", async () => {
    const { flow } = await newFlow();
    const got = await getFlow(WS, flow.id);
    expect(got.draft).toMatchObject({ version: 1, source: "TEMPLATE", state: "DRAFT" });
    expect(got.current).toMatchObject({ versionId: flow.draftVersionId, editable: true });
    expect(got.published).toBeNull();
    await expect(getFlow(OTHER, flow.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("versions, diff, restore", () => {
  it("lists versions newest first with states, diffs two versions and restores an old one as the draft", async () => {
    const { flow } = await newFlow();
    const v1 = flow.draftVersionId!;
    const g1 = flowGraphDraftSchema.parse(versionRow(v1).graph);
    Object.assign(versionRow(v1), { publishedAt: new Date() });
    Object.assign(flowRow(flow.id), { status: "PUBLISHED", publishedVersionId: v1 });
    const v2 = (await saveDraft(WS, flow.id, { graph: withEdited(g1, "ikkinchi versiya") })).version.id;

    const versions = await listVersions(WS, flow.id);
    expect(versions.map((v) => [v.version, v.state])).toEqual([
      [2, "DRAFT"],
      [1, "PUBLISHED"],
    ]);
    const diff = await diffVersions(WS, flow.id, v1, v2);
    expect(diff.diff.changed).toHaveLength(1);
    expect(diff.diff.changed[0].fields[0]).toMatchObject({ field: "text", after: "ikkinchi versiya" });
    await expect(diffVersions(WS, flow.id, v1, "nope")).rejects.toMatchObject({ status: 404 });
    await expect(diffVersions(OTHER, flow.id, v1, v2)).rejects.toMatchObject({ status: 404 });

    const restored = await restoreVersion(WS, flow.id, v1);
    expect(restored.version.id).toBe(v2);
    expect(versionRow(v2).hash).toBe(hashGraph(g1));
    expect(versionRow(v2).changeNote).toContain("v1");
    const detail = await getVersion(WS, flow.id, v1);
    expect(detail.graph).toBeTruthy();
    await expect(getVersion(WS, flow.id, "nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("templates", () => {
  it("lists the five starters plus this workspace's saved templates only", async () => {
    db.seed("flowTemplate", { workspaceId: OTHER, key: "ws:x:y", name: "Boshqaniki", category: "sales", graph: findStarterTemplate(T1)!.graph });
    const first = await listTemplates(WS);
    expect(first.filter((t) => t.builtIn)).toHaveLength(FLOW_STARTER_TEMPLATES.length);
    expect(first).toHaveLength(5);

    const { flow } = await newFlow();
    const saved = await saveAsTemplate(WS, { flowId: flow.id, name: "Mening shablonim", category: "sales" });
    const list = await listTemplates(WS);
    expect(list).toHaveLength(6);
    expect(list.find((t) => t.key === saved.key)).toMatchObject({ name: "Mening shablonim", builtIn: false, triggerType: "COMMENT" });

    // A saved template is copyable.
    const copy = await createFlow(WS, { instagramAccountId: "a1", fromTemplateKey: saved.key });
    expect(copy.flow.name).toBe("Mening shablonim");
    // Another workspace cannot use it or delete it.
    await expect(createFlow(OTHER, { instagramAccountId: "a2", fromTemplateKey: saved.key })).rejects.toMatchObject({ status: 404 });
    await expect(deleteTemplate(OTHER, saved.id)).rejects.toMatchObject({ status: 404 });
    await deleteTemplate(WS, saved.id);
    expect(await listTemplates(WS)).toHaveLength(5);
  });

  it("refuses to save an incomplete flow as a template", async () => {
    const { flow } = await newFlow();
    await saveDraft(WS, flow.id, {
      graph: { v: 1, nodes: [{ id: "t", type: "trigger", triggerType: "COMMENT", matchingMode: "EVERY" }, { id: "m1", type: "message", text: "Salom", button: { id: "a", label: "Ha" } }], edges: [] },
    });
    await expect(saveAsTemplate(WS, { flowId: flow.id, name: "Yarim" })).rejects.toMatchObject({ status: 422 });
    await expect(saveAsTemplate(OTHER, { flowId: flow.id, name: "Yarim" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("meta", () => {
  it("returns accounts with the JavobAI mode, tags, stages, intents and editor vocabulary for this workspace only", async () => {
    db.seed("javobAiAccount", { workspaceId: WS, instagramAccountId: "a1", mode: "LIVE" });
    db.seed("crmTag", { workspaceId: WS, name: "VIP", slug: "vip" });
    db.seed("crmTag", { workspaceId: OTHER, name: "Boshqa", slug: "boshqa" });
    db.seed("crmPipeline", { id: "p1", workspaceId: WS, name: "Sotuv", isDefault: true });
    db.seed("crmStage", { id: "s1", pipelineId: "p1", name: "Yangi", sort: 0, kind: "OPEN", isEntry: true });
    const m = await meta(WS);
    expect(m.accounts).toEqual([expect.objectContaining({ id: "a1", javobAiMode: "LIVE" })]);
    expect(m.tags.map((t) => t.slug)).toEqual(["vip"]);
    expect(m.pipelines[0].stages).toEqual([expect.objectContaining({ id: "s1", name: "Yangi" })]);
    expect(m.intents.length).toBeGreaterThan(3);
    expect(m.nodeLabels.message).toBe("Xabar");
    expect(m.limits.quickReplies).toBe(13);
    expect(Object.keys(m.fieldSpecs).length).toBeGreaterThan(10);
    expect(m.disabled).toBe(false);
  });
});

describe("run adapter", () => {
  it("maps a FlowServiceError to a failure result and keeps unknown errors as 500", async () => {
    const missing = await run(() => getFlow(WS, "nope"));
    expect(missing).toMatchObject({ ok: false, status: 404 });
    const boom = await run(async () => {
      throw new Error("x");
    });
    expect(boom).toMatchObject({ ok: false, status: 500 });
  });
});

describe("renameFlow (partial PATCH)", () => {
  it("a mode switch alone (no name) is accepted and keeps the graph; a rename alone keeps the mode", async () => {
    const { flow, vid } = await (async () => {
      const f = (await newFlow()).flow;
      return { flow: f, vid: f.draftVersionId! };
    })();
    const graphBefore = JSON.stringify(versionRow(vid).graph);
    await renameFlow(WS, flow.id, { mode: "ADVANCED" });
    expect(flowRow(flow.id)).toMatchObject({ mode: "ADVANCED", name: flow.name });
    await renameFlow(WS, flow.id, { mode: "SIMPLE" });
    expect(flowRow(flow.id).mode).toBe("SIMPLE");
    await renameFlow(WS, flow.id, { name: "  Yangi nom " });
    expect(flowRow(flow.id)).toMatchObject({ name: "Yangi nom", mode: "SIMPLE" });
    expect(JSON.stringify(versionRow(vid).graph)).toBe(graphBefore);
  });

  it("an empty body or empty name is a plain Uzbek 400, never a raw zod message", async () => {
    const { flow } = await newFlow();
    await expect(renameFlow(WS, flow.id, {})).rejects.toMatchObject({ status: 400, message: "Nom yoki rejim ko'rsatilmagan" });
    await expect(renameFlow(WS, flow.id, { name: "   " })).rejects.toMatchObject({ status: 400, message: "name: Nom kiritilmagan" });
    await expect(renameFlow(WS, flow.id, { mode: "X" })).rejects.toSatisfy((e: Error) => !/Invalid|expected/i.test(e.message));
  });
});

describe("M6: versions published before the test gate keep republishing", () => {
  /** A legacy published version: publishedAt set, testedAt null (it went live before the gate existed). */
  async function legacyPublished() {
    const { flow } = await newFlow();
    const v1 = flow.draftVersionId!;
    Object.assign(versionRow(v1), { publishedAt: new Date("2026-09-01T00:00:00Z"), testedAt: null });
    Object.assign(flowRow(flow.id), { status: "PUBLISHED", publishedVersionId: v1 });
    return { flow, v1 };
  }

  it("republishes a previously published version after unpublish without a new test", async () => {
    const { flow, v1 } = await legacyPublished();
    await unpublish(WS, flow.id);
    Object.assign(flowRow(flow.id), { status: "DRAFT", publishedVersionId: null });
    await expect(publishVersion(WS, flow.id, v1, { acknowledgeWarnings: true }, "u1")).resolves.toBeTruthy();
    expect(mocks.publishFlowVersion).toHaveBeenCalledWith(WS, flow.id, v1, { userId: "u1" });
  });

  it("a never-published, untested version still needs a test", async () => {
    const { flow } = await newFlow();
    await expect(publishVersion(WS, flow.id, flow.draftVersionId!, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("sinab ko'ring"),
    });
  });

  it("an edited copy of a published version needs a new test", async () => {
    const { flow, v1 } = await legacyPublished();
    const g1 = flowGraphDraftSchema.parse(versionRow(v1).graph);
    const v2 = (await saveDraft(WS, flow.id, { graph: withEdited(g1, "o'zgargan matn") })).version.id;
    expect(v2).not.toBe(v1);
    await expect(publishVersion(WS, flow.id, v2, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 422, message: expect.stringContaining("sinab ko'ring") });
  });

  it("restoring a published version gives a draft that publishes without a new test; editing it resets that", async () => {
    const { flow, v1 } = await legacyPublished();
    const g1 = flowGraphDraftSchema.parse(versionRow(v1).graph);
    const v2 = (await saveDraft(WS, flow.id, { graph: withEdited(g1, "ikkinchi") })).version.id;
    const restored = await restoreVersion(WS, flow.id, v1);
    expect(restored.version.id).toBe(v2);
    expect(versionRow(v2).hash).toBe(hashGraph(g1));
    expect(versionRow(v2).testedAt).toBeInstanceOf(Date);
    await expect(publishVersion(WS, flow.id, v2, { acknowledgeWarnings: true }, "u1")).resolves.toBeTruthy();

    // edit after the restore: the carried proof is gone
    await saveDraft(WS, flow.id, { graph: withEdited(g1, "yana boshqa") });
    expect(versionRow(v2).testedAt).toBeNull();
    await expect(publishVersion(WS, flow.id, v2, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 422 });
  });

  it("an AI version keeps its own rule: published before but untested still needs a test", async () => {
    const graph = findStarterTemplate(T1)!.graph;
    const created = await createFlow(WS, { name: "AI", instagramAccountId: "a1", graph, prompt: "x" }, { userId: "u1" });
    const vid = created.flow.draftVersionId!;
    Object.assign(versionRow(vid), { publishedAt: new Date(), testedAt: null, approvedAt: new Date() });
    await expect(publishVersion(WS, created.flow.id, vid, { acknowledgeWarnings: true }, "u1")).rejects.toMatchObject({ status: 422 });
  });
});
