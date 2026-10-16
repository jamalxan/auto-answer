/**
 * ETAP 11 — merge-field translation (pure) and the conversion call: prompt
 * contents, post-processing, audit + policy, budget gate, repair round, usage
 * row, nothing saved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import { type LLMProvider, type LlmRequest, setLlmProviderForTests } from "../lib/assistant/llm/provider";
import { flowGraphSchema, type FlowGraph } from "../lib/flows/schema";
import { findStarterTemplate } from "../lib/flows/templates";
import { convertFlowText, MERGE_FIELD_TABLE, mergeFieldTableLines, postProcessGraph, translateMergeFields } from "../lib/migration/converter";
import { MigrationServiceError } from "../lib/migration/errors";

const WS = "w1";
const TEXT = 'Trigger: Instagram Comments, keyword "narx". Send Message "Salom {{first_name}}!" Quick Reply "Ha". Add Tag lead.';

const customFields = [{ key: "city", type: "string" as const, name: "City", sourceId: "555" }, { key: "age", type: "number" as const, name: "Yosh", sourceId: "556" }];
const botVars = [{ varKey: "shop_name", value: "Mebel Uz", name: "Shop Name" }];

function baseGraph(): FlowGraph {
  return JSON.parse(JSON.stringify(findStarterTemplate("comment_price_lead")!.graph));
}

function withTexts(m1: string, m2: string): FlowGraph {
  const g = baseGraph();
  for (const node of g.nodes) {
    if (node.id === "m1" && node.type === "message") node.text = m1;
    if (node.id === "m2" && node.type === "message") node.text = m2;
  }
  return g;
}

function provider(replies: Array<unknown | Error>): LLMProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const queue = [...replies];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    costUsd: () => 0.02,
    async complete(request: LlmRequest) {
      calls.push(request);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { json: next, inputTokens: 300, outputTokens: 400, model: "fake-model", latencyMs: 9 };
    },
  };
}

beforeEach(() => {
  resetDb();
  setLlmProviderForTests(undefined);
  db.seed("workspace", { id: WS, ownerId: "u1", name: "Mebel" });
  db.seed("workspace", { id: "w2", ownerId: "u2", name: "Boshqa" });
  db.seed("instagramAccount", { id: "a1", workspaceId: WS, username: "mebel", instagramId: "ig1" });
  db.seed("instagramAccount", { id: "a2", workspaceId: "w2", username: "x", instagramId: "ig2" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("translateMergeFields", () => {
  it("translates the usual ManyChat spellings", () => {
    const r = translateMergeFields("Salom {{first_name}}, {first_name}, @first_name! Tel: {{phone}} / {{ email }} / {{ig_username}}");
    expect(r.text).toBe("Salom {{name}}, {{name}}, {{name}}! Tel: {{phone}} / {{ email }} / {{username}}");
    expect(r.notes.join(" ")).toMatch(/first_name/);
  });

  it("keeps fallbacks, drops last_name cleanly, leaves valid SocialAuto templates alone", () => {
    expect(translateMergeFields("Hi {{first_name|do'st}}!").text).toBe("Hi {{name|do'st}}!");
    expect(translateMergeFields("Ism: {{first_name}} {{last_name}}, xush kelibsiz").text).toBe("Ism: {{name}}, xush kelibsiz");
    const same = "Salom {{name|do'stim}} {{vars.price|menejer aytadi}} {{contact.phone}} {{trigger.keyword}}";
    expect(translateMergeFields(same)).toEqual({ text: same, notes: [] });
  });

  it("does not touch ordinary text: emails, mentions, braces around unknown words", () => {
    const text = "Yozing: info@mebel.uz yoki @mebel_uz, {noto'g'ri} qavs, 50% chegirma";
    expect(translateMergeFields(text, {}).text).toBe(text);
  });

  it("maps custom fields by cuf id, key and name; unknown fields become vars with a note", () => {
    const r = translateMergeFields("{{cuf_555}} / {{city}} / {{ Yosh }} / {{brend}}", { customFields });
    expect(r.text).toBe("{{vars.city}} / {{vars.city}} / {{vars.age}} / {{vars.brend}}");
    expect(r.notes.join(" ")).toMatch(/brend/);
  });

  it("bot fields: value becomes the fallback unless one was written", () => {
    expect(translateMergeFields("Do'kon: {{vars.shop_name}}", { botVars }).text).toBe("Do'kon: {{vars.shop_name|Mebel Uz}}");
    expect(translateMergeFields("Do'kon: {{vars.shop_name|bizning do'kon}}", { botVars }).text).toBe("Do'kon: {{vars.shop_name|bizning do'kon}}");
    expect(translateMergeFields("Do'kon: {{Shop Name}}", { botVars }).text).toBe("Do'kon: {{vars.shop_name|Mebel Uz}}");
  });

  it("the table covers the documented names and is shown to the model", () => {
    for (const key of ["first_name", "last_name", "full_name", "phone", "email"]) expect(key in MERGE_FIELD_TABLE).toBe(true);
    const lines = mergeFieldTableLines(customFields, botVars).join("\n");
    expect(lines).toMatch(/first_name\}\} → \{\{name\}\}/);
    expect(lines).toMatch(/vars\.city/);
    expect(lines).toMatch(/vars\.shop_name\|Mebel Uz/);
  });
});

describe("postProcessGraph", () => {
  it("translates tokens the model left behind, injects defaults and declares used variables", () => {
    const graph = withTexts("Salom {{first_name}}! {{city}} uchun tugmani bosing 👇", "{{vars.shop_name}}: {{product|Mahsulot}} narxi {{vars.price|menejer aytadi}}");
    const result = postProcessGraph(graph, { customFields, botVars });
    expect(result.failed).toBe(false);
    const texts = result.graph.nodes.filter((n) => n.type === "message").map((n) => (n.type === "message" ? n.text : ""));
    expect(texts[0]).toContain("{{name}}");
    expect(texts[0]).toContain("{{vars.city}}");
    expect(texts[1]).toContain("{{vars.shop_name|Mebel Uz}}");
    const keys = result.graph.variables.map((v) => v.key);
    expect(keys).toEqual(expect.arrayContaining(["city", "shop_name", "price"]));
    expect(result.graph.variables.find((v) => v.key === "city")?.label).toBe("City");
    expect(flowGraphSchema.safeParse(result.graph).success).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("number custom fields are declared as numbers", () => {
    const result = postProcessGraph(withTexts("Yosh: {{age}}", "x {{vars.age}}"), { customFields });
    expect(result.graph.variables.find((v) => v.key === "age")?.kind).toBe("number");
  });
});

describe("convertFlowText", () => {
  const good = () => ({ name: "Narx so'rovi", summary: "Komment → narx", graph: withTexts("Salom {{first_name}}! Narxlar uchun tugmani bosing 👇", "Narx: {{vars.price|menejer aytadi}}. Katalog kerakmi?") });
  const input = { text: TEXT, workspaceId: WS, accountId: "a1" };

  it("builds the migration prompt, post-processes, audits and records one migration usage row; saves nothing", async () => {
    const p = provider([good()]);
    setLlmProviderForTests(p);
    const result = await convertFlowText({ ...input, customFields, botVars, tags: ["lead"] });

    expect(p.calls).toHaveLength(1);
    const call = p.calls[0];
    expect(call.system).toMatch(/SocialAuto/);
    expect(call.system).toMatch(/Convert this ManyChat flow description into a SocialAuto flow graph/);
    expect(call.system).toMatch(/aynan saqlang/);
    expect(call.system).toMatch(/first_name\}\} → \{\{name\}\}/);
    expect(call.system).toMatch(/HECH QACHON o'ylab topmang/);
    expect(call.messages[0].content).toContain("Salom {{first_name}}!");
    expect(call.messages[0].content).toMatch(/trigger_comment/);
    expect(call.messages[0].content).toMatch(/Tavsiya etilgan trigger turi: COMMENT/);
    expect(call.schemaName).toBe("flow_graph");

    const m1 = result.graph.nodes.find((n) => n.id === "m1");
    expect(m1 && m1.type === "message" && m1.text).toContain("{{name}}");
    expect(result.audit.errors).toEqual([]);
    expect(["PASS", "WARNING"]).toContain(result.policy.verdict);
    expect(result.warnings.some((w) => w.code === "merge_field")).toBe(true);
    expect(result.warnings.some((w) => w.code === "trigger_comment" || w.feature === "trigger_comment")).toBe(false);

    const rows = db.rows("llmUsage").filter((r) => r.kind === "javobai_migration");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: WS, ok: true, inputTokens: 300, outputTokens: 400 });
    expect(db.rows("flow")).toHaveLength(0);
    expect(db.rows("flowVersion")).toHaveLength(0);
  });

  it("surfaces analyser findings (payment, WhatsApp) as warnings", async () => {
    setLlmProviderForTests(provider([good()]));
    const result = await convertFlowText({ ...input, text: `${TEXT} Payment via Stripe. Then WhatsApp message.` });
    const features = result.warnings.map((w) => w.feature ?? w.code);
    expect(features).toEqual(expect.arrayContaining(["payment", "channel_whatsapp"]));
    expect(result.warnings.find((w) => w.feature === "payment")?.severity).toBe("error");
  });

  it("repairs once and uses both calls in one usage row", async () => {
    const p = provider(["bu JSON emas", good()]);
    setLlmProviderForTests(p);
    const result = await convertFlowText(input);
    expect(result.repaired).toBe(true);
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1].messages[0].content).toMatch(/OLDINGI JAVOB/);
    const rows = db.rows("llmUsage").filter((r) => r.kind === "javobai_migration");
    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(600);
  });

  it("422 after two bad answers, still records a usage row", async () => {
    setLlmProviderForTests(provider(["x", "y"]));
    await expect(convertFlowText(input)).rejects.toMatchObject({ status: 422 });
    expect(db.rows("llmUsage")).toHaveLength(1);
  });

  it("budget exhausted → 429 without calling the model", async () => {
    const p = provider([good()]);
    setLlmProviderForTests(p);
    db.seed("aiBudget", { workspaceId: WS, monthlyUsdSoft: 1, monthlyUsdHard: 1 });
    db.seed("llmUsage", { workspaceId: WS, kind: "javobai_reply", model: "m", costUsd: 5, ok: true, createdAt: new Date() });
    await expect(convertFlowText(input)).rejects.toMatchObject({ status: 429 });
    expect(p.calls).toHaveLength(0);
  });

  it("no provider → 503; provider crash → 502; short text → 400; foreign account → 404", async () => {
    await expect(convertFlowText(input)).rejects.toMatchObject({ status: 503 });
    setLlmProviderForTests(provider([new Error("boom")]));
    await expect(convertFlowText(input)).rejects.toMatchObject({ status: 502 });
    await expect(convertFlowText({ ...input, text: "qisqa" })).rejects.toBeInstanceOf(MigrationServiceError);
    await expect(convertFlowText({ ...input, accountId: "a2" })).rejects.toMatchObject({ status: 404 });
  });
});
