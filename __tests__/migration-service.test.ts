/**
 * ETAP 11 — the migration DB layer against the in-memory db: connect (key
 * stored encrypted, never returned), idempotent analysis that keeps owner
 * edits, mapping edits, flow text (typed / screenshots never stored), the
 * budget- and rate-limited conversion preview, DRAFT import, basics import,
 * workspace scoping and the kill switch. ManyChat and the LLM are fakes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

const mocks = vi.hoisted(() => ({
  publishFlowVersion: vi.fn(),
  unpublishFlow: vi.fn(),
  archiveFlow: vi.fn(),
  runFlowSandbox: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/flows/publish", () => ({ publishFlowVersion: mocks.publishFlowVersion, unpublishFlow: mocks.unpublishFlow, archiveFlow: mocks.archiveFlow }));
vi.mock("@/lib/flows/sandbox", () => ({ runFlowSandbox: mocks.runFlowSandbox }));

import { type LLMProvider, type LlmRequest, setLlmProviderForTests } from "../lib/assistant/llm/provider";
import { FlowServiceError } from "../lib/flows/errors";
import type { FlowGraph } from "../lib/flows/schema";
import { findStarterTemplate } from "../lib/flows/templates";
import { MAX_FLOW_TEXT, MAX_SCREENSHOTS } from "../lib/migration/config";
import { resetMigrationLimitsForTests } from "../lib/migration/limits";
import { ManychatError, type ManychatClient } from "../lib/migration/manychat-client";
import {
  analyzeProject,
  connectManychat,
  convertFlow,
  deleteProject,
  getItem,
  getProject,
  importBasics,
  importFlow,
  listProjects,
  patchItem,
  run,
  setManychatClientFactoryForTests,
  submitFlowText,
} from "../lib/migration/service";
import { decryptToken } from "../lib/meta/oauth";

const WS = "w1";
const OTHER = "w2";
const KEY = "99999:SuperSecretManyChatKey1234";
const FLOW_TEXT = 'Trigger: Instagram Comments, keyword "narx". Send Message "Salom {{first_name}}! Narxlar uchun tugmani bosing". Quick Reply "Ha". Add Tag VIP. Smart Delay 10 minutes.';

interface Data {
  tags: Array<{ id: string; name: string }>;
  fields: Array<{ id: string; name: string; type: string }>;
  bots: Array<{ id: string; name: string; type: string; value: string | null }>;
  flows: Array<{ ns: string; name: string; folder: string | null }>;
  tools: Array<{ id: string; name: string; type: string | null }>;
}

let data: Data;
let clientCalls: string[];
let authFails: boolean;

function freshData(): Data {
  return {
    tags: [{ id: "t1", name: "VIP" }, { id: "t2", name: "Yangi mijoz" }],
    fields: [{ id: "f1", name: "Telefon", type: "text" }, { id: "f2", name: "Yosh", type: "number" }],
    bots: [{ id: "b1", name: "Do'kon nomi", type: "text", value: "Mebel Uz" }, { id: "b2", name: "Narx", type: "text", value: "120000" }],
    flows: [{ ns: "content1", name: "Salomlashuv", folder: "Asosiy" }, { ns: "content2", name: "Narx so'rovi", folder: null }],
    tools: [{ id: "g1", name: "Komment narx", type: "ig_comments" }],
  };
}

function fakeClient(): ManychatClient {
  const guard = (name: string) => {
    clientCalls.push(name);
    if (authFails) throw new ManychatError("auth", "ManyChat API kaliti noto'g'ri yoki ruxsati yo'q.", 401);
  };
  return {
    getInfo: async () => (guard("info"), { id: "p1", name: "Mebel Page", username: "mebel", category: null, isPro: true, timezone: null }),
    getTags: async () => (guard("tags"), data.tags),
    getCustomFields: async () => (guard("fields"), data.fields.map((f) => ({ ...f, description: null }))),
    getBotFields: async () => (guard("bots"), data.bots),
    getFlows: async () => (guard("flows"), data.flows),
    getGrowthTools: async () => (guard("tools"), data.tools),
  };
}

function provider(replies: Array<unknown | Error>): LLMProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const queue = [...replies];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    costUsd: () => 0.01,
    async complete(request: LlmRequest) {
      calls.push(request);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { json: next, inputTokens: 100, outputTokens: 200, model: "fake-model", latencyMs: 5 };
    },
  };
}

function graphWith(m1: string): FlowGraph {
  const g: FlowGraph = JSON.parse(JSON.stringify(findStarterTemplate("comment_price_lead")!.graph));
  for (const node of g.nodes) if (node.id === "m1" && node.type === "message") node.text = m1;
  return g;
}
const goodReply = () => ({ name: "Narx so'rovi", summary: "Komment → narx", graph: graphWith("Salom {{first_name}}! Narxlar uchun tugmani bosing 👇") });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]).toString("base64");

async function connect(workspaceId = WS, name = "ManyChat") {
  return connectManychat(workspaceId, { name, apiKey: KEY, instagramAccountId: workspaceId === WS ? "a1" : "a2" }, "u1");
}

const items = (kind?: string) => db.rows("migrationItem").filter((r) => !kind || r.kind === kind);
const itemId = (kind: string, sourceId: string) => items(kind).find((r) => r.sourceId === sourceId)!.id as string;

beforeEach(() => {
  resetDb();
  data = freshData();
  clientCalls = [];
  authFails = false;
  setLlmProviderForTests(undefined);
  resetMigrationLimitsForTests();
  setManychatClientFactoryForTests(() => fakeClient());
  db.seed("workspace", { id: WS, ownerId: "u1", name: "Mebel" });
  db.seed("workspace", { id: OTHER, ownerId: "u2", name: "Boshqa" });
  db.seed("instagramAccount", { id: "a1", workspaceId: WS, username: "mebel", instagramId: "ig1" });
  db.seed("instagramAccount", { id: "a2", workspaceId: OTHER, username: "x", instagramId: "ig2" });
  mocks.publishFlowVersion.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  setManychatClientFactoryForTests(null);
});

describe("connectManychat", () => {
  it("validates the key, stores it encrypted with a 4 character hint, analyses and never returns the key", async () => {
    const result = await connect();
    const row = db.rows("migrationProject")[0];
    expect(row.apiKeyEncrypted).toBeTruthy();
    expect(row.apiKeyEncrypted).not.toContain("SuperSecret");
    expect(decryptToken(row.apiKeyEncrypted as string)).toBe(KEY);
    expect(row.apiKeyHint).toBe("1234");
    expect(row.workspaceId).toBe(WS);
    expect(row.createdByUserId).toBe("u1");

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SuperSecret");
    expect(serialized).not.toContain(row.apiKeyEncrypted as string);
    expect(serialized).not.toContain("apiKeyEncrypted");
    expect(result.project).toMatchObject({ status: "ANALYZED", apiKeyHint: "1234", hasKey: true });
    expect(result.items.TAG).toHaveLength(2);
    expect(result.items.CUSTOM_FIELD).toHaveLength(2);
    expect(result.items.BOT_FIELD).toHaveLength(2);
    expect(result.items.FLOW).toHaveLength(2);
    expect(result.items.GROWTH_TOOL).toHaveLength(1);
    expect(result.counts.FLOW.total).toBe(2);
    expect(result.checklist.todo.join("\n")).toMatch(/ig\.me/);
    expect(result.contactGuidance).toMatch(/obunachilar/i);
    expect(JSON.stringify(db.tables)).not.toContain(KEY);
  });

  it("maps defaults: tag slugs, snake_case field keys, bot variable keys", async () => {
    const result = await connect();
    expect(result.items.TAG.map((t) => t.mapping)).toEqual([{ targetSlug: "vip", action: "create" }, { targetSlug: "yangi-mijoz", action: "create" }]);
    expect(result.items.CUSTOM_FIELD.map((f) => f.mapping.key)).toEqual(["telefon", "yosh"]);
    expect(result.items.CUSTOM_FIELD[1].mapping.type).toBe("number");
    expect(result.items.BOT_FIELD.map((f) => [f.mapping.varKey, f.mapping.value])).toEqual([["dokon_nomi", "Mebel Uz"], ["narx", "120000"]]);
  });

  it("an invalid key is a 422 and nothing is stored", async () => {
    authFails = true;
    await expect(connect()).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/API kaliti/) });
    expect(db.rows("migrationProject")).toHaveLength(0);
  });

  it("rejects bad input and foreign accounts", async () => {
    await expect(connectManychat(WS, { name: "", apiKey: KEY }, "u1")).rejects.toMatchObject({ status: 400 });
    await expect(connectManychat(WS, { name: "x", apiKey: "short" }, "u1")).rejects.toMatchObject({ status: 400 });
    await expect(connectManychat(WS, { name: "x", apiKey: KEY, instagramAccountId: "a2" }, "u1")).rejects.toMatchObject({ status: 404 });
    expect(db.rows("migrationProject")).toHaveLength(0);
  });

  it("a failing analysis keeps the project (status FAILED, reason shown)", async () => {
    let calls = 0;
    setManychatClientFactoryForTests(() => ({ ...fakeClient(), getTags: async () => { calls += 1; throw new ManychatError("server", "ManyChat serveri javob bermadi", 500); } }));
    const result = await connect();
    expect(calls).toBe(1);
    expect(result.project.status).toBe("FAILED");
    expect(result.project.lastError).toMatch(/ManyChat/);
  });
});

describe("analyzeProject", () => {
  it("is idempotent and keeps the owner's edits", async () => {
    const first = await connect();
    const project = first.project.id;
    await patchItem(WS, project, itemId("TAG", "t1"), { mapping: { targetSlug: "Premium Mijoz" } });
    await patchItem(WS, project, itemId("FLOW", "content1"), { status: "SKIPPED" });
    const before = items().length;

    const again = await analyzeProject(WS, project);
    expect(items()).toHaveLength(before);
    expect(again.items.TAG.find((t) => t.sourceId === "t1")?.mapping.targetSlug).toBe("premium-mijoz");
    expect(again.items.FLOW.find((f) => f.sourceId === "content1")?.status).toBe("SKIPPED");

    await analyzeProject(WS, project);
    expect(items()).toHaveLength(before);
  });

  it("picks up new objects and renames; marks vanished items SKIPPED (not deleted) and restores them", async () => {
    const first = await connect();
    const project = first.project.id;
    data.tags = [{ id: "t1", name: "VIP mijoz" }, { id: "t3", name: "Hot" }];
    data.flows = [{ ns: "content1", name: "Salomlashuv v2", folder: "Asosiy" }];
    const second = await analyzeProject(WS, project);

    expect(second.items.TAG.find((t) => t.sourceId === "t1")?.name).toBe("VIP mijoz");
    expect(second.items.TAG.find((t) => t.sourceId === "t3")?.status).toBe("PENDING");
    const gone = second.items.TAG.find((t) => t.sourceId === "t2")!;
    expect(gone.status).toBe("SKIPPED");
    expect(gone.note).toMatch(/topilmadi/);
    expect(second.items.FLOW.find((f) => f.sourceId === "content2")?.status).toBe("SKIPPED");
    expect(second.items.FLOW.find((f) => f.sourceId === "content1")?.name).toBe("Salomlashuv v2");
    expect(items("TAG")).toHaveLength(3);

    data.tags.push({ id: "t2", name: "Yangi mijoz" });
    const third = await analyzeProject(WS, project);
    expect(third.items.TAG.find((t) => t.sourceId === "t2")).toMatchObject({ status: "PENDING", note: null });
  });

  it("an already imported item is not downgraded when it vanishes", async () => {
    const first = await connect();
    await importBasics(WS, first.project.id, { tags: true, customFields: false, botFields: false });
    data.tags = [];
    const result = await analyzeProject(WS, first.project.id);
    for (const tag of result.items.TAG) expect(tag.status).toBe("IMPORTED");
  });

  it("a section ManyChat does not have (404) does not wipe the items of that section", async () => {
    const first = await connect();
    setManychatClientFactoryForTests(() => ({ ...fakeClient(), getGrowthTools: async () => { throw new ManychatError("not_found", "yo'q", 404); } }));
    const result = await analyzeProject(WS, first.project.id);
    expect(result.items.GROWTH_TOOL[0].status).toBe("PENDING");
  });

  it("ManyChat errors surface with their status and lastError", async () => {
    const first = await connect();
    authFails = true;
    await expect(analyzeProject(WS, first.project.id)).rejects.toMatchObject({ status: 422 });
    expect(db.rows("migrationProject")[0].lastError).toMatch(/API kaliti/);
  });
});

describe("patchItem", () => {
  it("renames a tag slug (merge when it exists), picks custom field keys, skips", async () => {
    const { project } = await connect();
    db.seed("crmTag", { workspaceId: WS, name: "Eski", slug: "eski" });
    const tag = await patchItem(WS, project.id, itemId("TAG", "t2"), { mapping: { targetSlug: "Eski" } });
    expect(tag.item.mapping).toMatchObject({ targetSlug: "eski", action: "merge" });
    expect(tag.item.status).toBe("MAPPED");

    const field = await patchItem(WS, project.id, itemId("CUSTOM_FIELD", "f1"), { mapping: { key: "phone_number" } });
    expect(field.item.mapping).toMatchObject({ key: "phone_number", type: "string" });

    const skipped = await patchItem(WS, project.id, itemId("FLOW", "content2"), { status: "SKIPPED" });
    expect(skipped.item.status).toBe("SKIPPED");
  });

  it("validates keys and uniqueness", async () => {
    const { project } = await connect();
    await expect(patchItem(WS, project.id, itemId("CUSTOM_FIELD", "f1"), { mapping: { key: "Bad Key" } })).rejects.toMatchObject({ status: 400 });
    await expect(patchItem(WS, project.id, itemId("CUSTOM_FIELD", "f1"), { mapping: { key: "yosh" } })).rejects.toMatchObject({ status: 422 });
    await expect(patchItem(WS, project.id, itemId("BOT_FIELD", "b1"), { mapping: { varKey: "narx" } })).rejects.toMatchObject({ status: 422 });
    await expect(patchItem(WS, project.id, itemId("TAG", "t1"), { mapping: { targetSlug: "!!!" } })).rejects.toMatchObject({ status: 422 });
    await expect(patchItem(WS, project.id, itemId("TAG", "t1"), {})).rejects.toMatchObject({ status: 400 });
    await expect(patchItem(WS, project.id, itemId("TAG", "t1"), { status: "IMPORTED" })).rejects.toMatchObject({ status: 400 });
  });

  it("cleans bot values of braces and refuses edits of imported items", async () => {
    const { project } = await connect();
    const bot = await patchItem(WS, project.id, itemId("BOT_FIELD", "b1"), { mapping: { value: "{{x}} Do'kon" } });
    expect(bot.item.mapping.value).toBe("x Do'kon");
    await importBasics(WS, project.id, { tags: true, customFields: false, botFields: false });
    await expect(patchItem(WS, project.id, itemId("TAG", "t1"), { status: "SKIPPED" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("submitFlowText", () => {
  it("stores the typed text, runs the analyser into warnings and marks the item MAPPED", async () => {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    const result = await submitFlowText(WS, project.id, id, { text: `${FLOW_TEXT} Payment via Stripe.` });
    expect(result.item.status).toBe("MAPPED");
    expect(result.item.sourceText).toContain("Salom");
    expect(result.analysis.triggers.map((t) => t.kind)).toContain("trigger_comment");
    expect(result.item.warnings.map((w) => (w as { feature?: string }).feature)).toContain("payment");
    expect((await getItem(WS, project.id, id)).item.sourceText).toContain("Stripe");
    // The list view carries a preview only.
    const view = (await getProject(WS, project.id)).items.FLOW.find((f) => f.id === id)!;
    expect(view.hasText).toBe(true);
    expect(view).not.toHaveProperty("sourceText");
  });

  it("rejects over-long text, empty input and non-flow items; caps the combined text", async () => {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    await expect(submitFlowText(WS, project.id, id, { text: "x".repeat(MAX_FLOW_TEXT + 1) })).rejects.toMatchObject({ status: 400 });
    await expect(submitFlowText(WS, project.id, id, {})).rejects.toMatchObject({ status: 400 });
    await expect(submitFlowText(WS, project.id, itemId("TAG", "t1"), { text: FLOW_TEXT })).rejects.toMatchObject({ status: 400 });

    const edge = await submitFlowText(WS, project.id, id, { text: "y".repeat(MAX_FLOW_TEXT) });
    expect(String(edge.item.sourceText).length).toBe(MAX_FLOW_TEXT);
  });

  it("reads screenshots through the vision model, stores only the text, records usage and never stores the image", async () => {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    const p = provider([{ text: 'Trigger: Instagram Comments keyword "narx". Send Message "Salom". Zapier request.' }]);
    setLlmProviderForTests(p);
    const result = await submitFlowText(WS, project.id, id, { text: "Qo'shimcha: VIP teg", images: [{ mediaType: "image/png", base64: PNG }] });

    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].images).toEqual([{ mediaType: "image/png", base64: PNG }]);
    expect(result.item.sourceText).toContain("Qo'shimcha");
    expect(result.item.sourceText).toContain("Zapier");
    expect(result.extractedChars).toBeGreaterThan(10);
    expect(JSON.stringify(db.tables)).not.toContain(PNG);
    expect(JSON.stringify(result)).not.toContain(PNG);
    const usage = db.rows("llmUsage").filter((r) => r.kind === "javobai_migration");
    expect(usage).toHaveLength(1);
    expect(usage[0].ok).toBe(true);
  });

  it("validates screenshots: count, type, size, real image bytes, base64", async () => {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    setLlmProviderForTests(provider([{ text: "x" }]));
    const png = { mediaType: "image/png", base64: PNG };
    await expect(submitFlowText(WS, project.id, id, { images: Array(MAX_SCREENSHOTS + 1).fill(png) })).rejects.toMatchObject({ status: 400 });
    await expect(submitFlowText(WS, project.id, id, { images: [{ mediaType: "image/gif", base64: PNG }] })).rejects.toMatchObject({ status: 400 });
    await expect(submitFlowText(WS, project.id, id, { images: [{ mediaType: "image/png", base64: "!!!not base64!!!" }] })).rejects.toMatchObject({ status: 400 });
    const notAnImage = Buffer.from("<html>not an image at all</html>").toString("base64");
    await expect(submitFlowText(WS, project.id, id, { images: [{ mediaType: "image/png", base64: notAnImage }] })).rejects.toMatchObject({ status: 400 });
    const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4_100_000)]).toString("base64");
    await expect(submitFlowText(WS, project.id, id, { images: [{ mediaType: "image/png", base64: huge }] })).rejects.toMatchObject({ status: 400 });
    expect(db.rows("llmUsage")).toHaveLength(0);
  });

  it("screenshots are budget gated and need an LLM", async () => {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    const png = { mediaType: "image/png", base64: PNG };
    await expect(submitFlowText(WS, project.id, id, { images: [png] })).rejects.toMatchObject({ status: 503 });
    const p = provider([{ text: "x y z flow text" }]);
    setLlmProviderForTests(p);
    db.seed("aiBudget", { workspaceId: WS, monthlyUsdSoft: 1, monthlyUsdHard: 1, periodStart: new Date(), alerted50At: null, alerted80At: null, alerted100At: null });
    db.seed("llmUsage", { workspaceId: WS, kind: "javobai_reply", model: "m", costUsd: 5, ok: true, createdAt: new Date() });
    await expect(submitFlowText(WS, project.id, id, { images: [png] })).rejects.toMatchObject({ status: 429 });
    expect(p.calls).toHaveLength(0);
  });
});

describe("convertFlow (preview)", () => {
  async function ready() {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    await submitFlowText(WS, project.id, id, { text: FLOW_TEXT });
    return { projectId: project.id, id };
  }

  it("returns graph, name, summary, warnings, audit and policy; creates no flow; marks the item CONVERTED", async () => {
    const { projectId, id } = await ready();
    const p = provider([goodReply()]);
    setLlmProviderForTests(p);
    const result = await convertFlow(WS, projectId, id, { instagramAccountId: "a1" });
    expect(result.name).toBe("Narx so'rovi");
    expect(result.graph.nodes.length).toBeGreaterThan(3);
    expect(result.audit.errors).toEqual([]);
    expect(result.policy.verdict).toBeDefined();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(db.rows("flow")).toHaveLength(0);
    expect(db.rows("flowVersion")).toHaveLength(0);
    const row = db.rows("migrationItem").find((r) => r.id === id)!;
    expect(row.status).toBe("CONVERTED");
    expect((row.mapping as Record<string, unknown>).lastConversion).toBeTruthy();
    // imported custom fields / bot fields reach the prompt
    expect(p.calls[0].system).toMatch(/vars\.telefon/);
    expect(p.calls[0].system).toMatch(/vars\.dokon_nomi\|Mebel Uz/);
  });

  it("needs text, an owned account, and is budget gated", async () => {
    const { project } = await connect();
    const empty = itemId("FLOW", "content2");
    setLlmProviderForTests(provider([goodReply()]));
    await expect(convertFlow(WS, project.id, empty, { instagramAccountId: "a1" })).rejects.toMatchObject({ status: 400 });
    const { projectId, id } = { projectId: project.id, id: itemId("FLOW", "content1") };
    await submitFlowText(WS, projectId, id, { text: FLOW_TEXT });
    await expect(convertFlow(WS, projectId, id, { instagramAccountId: "a2" })).rejects.toMatchObject({ status: 404 });
    await expect(convertFlow(WS, projectId, id, { triggerType: "COMMENT" })).rejects.toMatchObject({ status: 400 });

    db.seed("aiBudget", { workspaceId: WS, monthlyUsdSoft: 1, monthlyUsdHard: 1, periodStart: new Date(), alerted50At: null, alerted80At: null, alerted100At: null });
    db.seed("llmUsage", { workspaceId: WS, kind: "javobai_reply", model: "m", costUsd: 5, ok: true, createdAt: new Date() });
    await expect(convertFlow(WS, projectId, id, { instagramAccountId: "a1" })).rejects.toMatchObject({ status: 429 });
  });

  it("is limited to 20 AI calls per workspace per hour", async () => {
    const { projectId, id } = await ready();
    const p = provider([goodReply(), goodReply()]);
    setLlmProviderForTests(p);
    for (let i = 0; i < 20; i += 1) db.seed("llmUsage", { workspaceId: WS, kind: "javobai_migration", model: "m", costUsd: 0, ok: true, createdAt: new Date(Date.now() - 60_000) });
    await expect(convertFlow(WS, projectId, id, { instagramAccountId: "a1" })).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/20/) });
    expect(p.calls).toHaveLength(0);
    // rows older than an hour do not count
    db.tables.llmUsage = db.rows("llmUsage").map((r) => ({ ...r, createdAt: new Date(Date.now() - 2 * 3_600_000) }));
    await expect(convertFlow(WS, projectId, id, { instagramAccountId: "a1" })).resolves.toBeTruthy();
  });

  it("an unusable AI answer marks the item FAILED but it can be converted again", async () => {
    const { projectId, id } = await ready();
    setLlmProviderForTests(provider(["x", "y"]));
    await expect(convertFlow(WS, projectId, id, { instagramAccountId: "a1" })).rejects.toMatchObject({ status: 422 });
    expect(db.rows("migrationItem").find((r) => r.id === id)!.status).toBe("FAILED");
    setLlmProviderForTests(provider([goodReply()]));
    await convertFlow(WS, projectId, id, { instagramAccountId: "a1" });
    expect(db.rows("migrationItem").find((r) => r.id === id)!.status).toBe("CONVERTED");
  });
});

describe("importFlow", () => {
  async function ready(text = FLOW_TEXT) {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    await submitFlowText(WS, project.id, id, { text });
    return { projectId: project.id, id };
  }

  it("creates a DRAFT AI flow with the pasted text as prompt and never publishes", async () => {
    const { projectId, id } = await ready();
    setLlmProviderForTests(provider([goodReply()]));
    const result = await importFlow(WS, projectId, id, { instagramAccountId: "a1" }, "u1");

    const flow = db.rows("flow")[0];
    expect(flow).toMatchObject({ id: result.flowId, workspaceId: WS, instagramAccountId: "a1", status: "DRAFT", publishedVersionId: null, createdByUserId: "u1" });
    const version = db.rows("flowVersion")[0];
    expect(version).toMatchObject({ source: "AI", prompt: FLOW_TEXT });
    expect(flow.draftVersionId).toBe(version.id);
    expect(mocks.publishFlowVersion).not.toHaveBeenCalled();
    const item = db.rows("migrationItem").find((r) => r.id === id)!;
    expect(item).toMatchObject({ status: "IMPORTED", flowId: flow.id });
    expect(result.evaluation).toBeTruthy();
    expect((await getProject(WS, projectId)).project.status).toBeDefined();
  });

  it("uses a supplied (edited) graph without another AI call; the prompt is capped at 2000 characters", async () => {
    const { projectId, id } = await ready("Trigger: Instagram Comments keyword narx. " + "Send Message salom. ".repeat(300));
    const p = provider([]);
    setLlmProviderForTests(p);
    await importFlow(WS, projectId, id, { instagramAccountId: "a1", graph: graphWith("Salom {{name}}! Tugmani bosing 👇"), name: "Mening oqimim" });
    expect(p.calls).toHaveLength(0);
    expect(db.rows("flow")[0].name).toBe("Mening oqimim");
    expect(String(db.rows("flowVersion")[0].prompt).length).toBeLessThanOrEqual(2000);
    expect(db.rows("llmUsage")).toHaveLength(0);
  });

  it("refuses a second import, needs text, scopes the account, and maps flow errors", async () => {
    const { projectId, id } = await ready();
    await expect(importFlow(WS, projectId, itemId("FLOW", "content2"), { instagramAccountId: "a1", graph: graphWith("x") })).rejects.toMatchObject({ status: 400 });
    await expect(importFlow(WS, projectId, id, { instagramAccountId: "a2", graph: graphWith("Salom! Tugmani bosing 👇") })).rejects.toMatchObject({ status: 404 });
    await expect(importFlow(WS, projectId, id, { instagramAccountId: "a1", graph: { v: 1, nodes: "bad" } })).rejects.toMatchObject({ status: 400 });
    expect(db.rows("flow")).toHaveLength(0);
    expect(db.rows("migrationItem").find((r) => r.id === id)!.status).toBe("MAPPED");

    await importFlow(WS, projectId, id, { instagramAccountId: "a1", graph: graphWith("Salom! Tugmani bosing 👇") });
    await expect(importFlow(WS, projectId, id, { instagramAccountId: "a1", graph: graphWith("Salom! Tugmani bosing 👇") })).rejects.toMatchObject({ status: 409 });
    await expect(submitFlowText(WS, projectId, id, { text: FLOW_TEXT })).rejects.toMatchObject({ status: 409 });
    expect(db.rows("flow")).toHaveLength(1);
  });

  it("run() maps service, flow and unexpected errors to results", async () => {
    expect(await run(async () => 1)).toEqual({ ok: true, data: 1 });
    expect(await run(async () => connect(WS).then(() => getProject(WS, "nope")))).toMatchObject({ ok: false, status: 404 });
    expect(await run(async () => { throw new FlowServiceError(422, "Oqim xato"); })).toEqual({ ok: false, status: 422, error: "Oqim xato" });
    const unexpected = await run(async () => { throw new Error(`boom ${KEY}`); });
    expect(unexpected).toMatchObject({ ok: false, status: 500 });
    expect(JSON.stringify(unexpected)).not.toContain(KEY);
  });
});

describe("importBasics", () => {
  it("creates CRM tags once, merges existing ones, records fields and variables", async () => {
    const { project } = await connect();
    db.seed("crmTag", { workspaceId: WS, name: "VIP", slug: "vip" });
    const first = await importBasics(WS, project.id, { tags: true, customFields: true, botFields: true });
    expect(first.tags).toEqual({ created: 1, merged: 1, failed: 0 });
    expect(first.customFields).toEqual({ imported: 2, failed: 0 });
    expect(first.botFields).toEqual({ imported: 2, failed: 0 });
    expect(db.rows("crmTag").map((t) => t.slug).sort()).toEqual(["vip", "yangi-mijoz"]);
    expect(first.items.TAG.every((t) => t.status === "IMPORTED")).toBe(true);
    expect(first.items.TAG.map((t) => t.mapping.action)).toEqual(["merge", "create"]);
    expect(first.checklist.done.join("\n")).toMatch(/2 ta teg/);

    const second = await importBasics(WS, project.id, { tags: true, customFields: true, botFields: true });
    expect(second.tags).toEqual({ created: 0, merged: 0, failed: 0 });
    expect(db.rows("crmTag")).toHaveLength(2);
  });

  it("only touches the groups asked for; nothing selected is refused", async () => {
    const { project } = await connect();
    await expect(importBasics(WS, project.id, {})).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/hech narsa/i) });
    expect(db.rows("crmTag")).toHaveLength(0);
    await importBasics(WS, project.id, { tags: false, customFields: true, botFields: false });
    expect(items("CUSTOM_FIELD").every((r) => r.status === "IMPORTED")).toBe(true);
    expect(items("BOT_FIELD").every((r) => r.status === "PENDING")).toBe(true);
    expect(db.rows("crmTag")).toHaveLength(0);
  });

  it("uses the edited slug and skips skipped tags", async () => {
    const { project } = await connect();
    await patchItem(WS, project.id, itemId("TAG", "t1"), { mapping: { targetSlug: "premium" } });
    await patchItem(WS, project.id, itemId("TAG", "t2"), { status: "SKIPPED" });
    await importBasics(WS, project.id, { tags: true, customFields: false, botFields: false });
    expect(db.rows("crmTag").map((t) => t.slug)).toEqual(["premium"]);
  });
});

describe("workspace scoping, listing, deletion, kill switch", () => {
  it("foreign project / item / account ids read as 404 everywhere", async () => {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    const other = WS === "w1" ? OTHER : WS;
    await expect(getProject(other, project.id)).rejects.toMatchObject({ status: 404 });
    await expect(analyzeProject(other, project.id)).rejects.toMatchObject({ status: 404 });
    await expect(patchItem(other, project.id, id, { status: "SKIPPED" })).rejects.toMatchObject({ status: 404 });
    await expect(submitFlowText(other, project.id, id, { text: FLOW_TEXT })).rejects.toMatchObject({ status: 404 });
    await expect(convertFlow(other, project.id, id, { instagramAccountId: "a2" })).rejects.toMatchObject({ status: 404 });
    await expect(importFlow(other, project.id, id, { instagramAccountId: "a2" })).rejects.toMatchObject({ status: 404 });
    await expect(importBasics(other, project.id, { tags: true })).rejects.toMatchObject({ status: 404 });
    await expect(deleteProject(other, project.id)).rejects.toMatchObject({ status: 404 });
    await expect(getItem(other, project.id, id)).rejects.toMatchObject({ status: 404 });
    // an item id from another project is not found under this project either
    await connect(OTHER, "Boshqa");
    const foreignItem = db.rows("migrationItem").find((r) => r.projectId !== project.id)!.id as string;
    await expect(patchItem(WS, project.id, foreignItem, { status: "SKIPPED" })).rejects.toMatchObject({ status: 404 });
    expect(db.rows("migrationProject")).toHaveLength(2);
  });

  it("listProjects shows only the workspace's projects with counts and no key", async () => {
    await connect();
    await connect(OTHER, "Boshqa");
    const list = await listProjects(WS);
    expect(list).toHaveLength(1);
    expect(list[0].counts.TAG.total).toBe(2);
    expect(JSON.stringify(list)).not.toContain("apiKeyEncrypted");
    expect(list[0].apiKeyHint).toBe("1234");
  });

  it("deleteProject cascades, wipes the key and leaves created flows alone", async () => {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    await submitFlowText(WS, project.id, id, { text: FLOW_TEXT });
    await importFlow(WS, project.id, id, { instagramAccountId: "a1", graph: graphWith("Salom! Tugmani bosing 👇") });
    await deleteProject(WS, project.id);
    expect(db.rows("migrationProject")).toHaveLength(0);
    expect(db.rows("migrationItem")).toHaveLength(0);
    expect(db.rows("flow")).toHaveLength(1);
    expect(JSON.stringify(db.tables)).not.toContain("SuperSecret");
  });

  it("MIGRATION_DISABLED stops connect / analyze / convert / import but not reading or deleting", async () => {
    const { project } = await connect();
    const id = itemId("FLOW", "content1");
    vi.stubEnv("MIGRATION_DISABLED", "1");
    await expect(connect()).rejects.toMatchObject({ status: 503 });
    await expect(analyzeProject(WS, project.id)).rejects.toMatchObject({ status: 503 });
    await expect(submitFlowText(WS, project.id, id, { text: FLOW_TEXT })).rejects.toMatchObject({ status: 503 });
    await expect(convertFlow(WS, project.id, id, { instagramAccountId: "a1" })).rejects.toMatchObject({ status: 503 });
    await expect(importFlow(WS, project.id, id, { instagramAccountId: "a1" })).rejects.toMatchObject({ status: 503 });
    await expect(importBasics(WS, project.id, { tags: true })).rejects.toMatchObject({ status: 503 });
    expect((await getProject(WS, project.id)).project.id).toBe(project.id);
    expect(await listProjects(WS)).toHaveLength(1);
    await expect(deleteProject(WS, project.id)).resolves.toEqual({ deleted: true });
  });
});
