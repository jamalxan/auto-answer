/**
 * ETAP 6.2 / 7 — starter templates are valid, audit-clean and publishable;
 * the AI builder prompt contract and the forgiving graph parser.
 */

import { describe, expect, it } from "vitest";
import {
  buildFlowBuilderPrompt,
  buildRepairPrompt,
  fewShotExamples,
  FLOW_BUILDER_JSON_SCHEMA,
  isFlowParseFailure,
  parseGraphFromLlm,
} from "../lib/flows/ai-builder-prompt";
import { auditGraph } from "../lib/flows/audit";
import { evaluatePolicy } from "../lib/flows/policy";
import { FLOW_TRIGGER_TYPES, flowGraphSchema } from "../lib/flows/schema";
import { findStarterTemplate, FLOW_STARTER_TEMPLATE_INPUTS, FLOW_STARTER_TEMPLATES } from "../lib/flows/templates";

describe("starter templates", () => {
  it("there are five, with unique keys and Uzbek metadata", () => {
    expect(FLOW_STARTER_TEMPLATES).toHaveLength(5);
    expect(new Set(FLOW_STARTER_TEMPLATES.map((t) => t.key)).size).toBe(5);
    expect(FLOW_STARTER_TEMPLATES.map((t) => t.key)).toEqual(["comment_price_lead", "story_mention_dm", "ad_qualify_crm", "faq_javobai", "giveaway_confirm"]);
    for (const t of FLOW_STARTER_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(5);
      expect(t.description.length).toBeGreaterThan(20);
      expect(FLOW_TRIGGER_TYPES).toContain(t.triggerType);
      expect(Array.isArray(t.tags)).toBe(true);
    }
    expect(findStarterTemplate("faq_javobai")?.triggerType).toBe("DIRECT_MESSAGE");
    expect(findStarterTemplate("nope")).toBeNull();
  });

  it.each(FLOW_STARTER_TEMPLATE_INPUTS.map((t) => [t.key, t] as const))("%s is schema-valid and its trigger type matches", (_key, template) => {
    const parsed = flowGraphSchema.safeParse(template.graph);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2)).toBe(true);
    const trigger = parsed.success ? parsed.data.nodes.find((n) => n.type === "trigger") : null;
    expect(trigger?.type === "trigger" && trigger.triggerType).toBe(template.triggerType);
  });

  it.each(FLOW_STARTER_TEMPLATES.map((t) => [t.key, t] as const))("%s audits with 0 errors and 0 warnings and passes policy", (_key, template) => {
    const audit = auditGraph(template.graph, { declaredTags: template.tags, javobAiMode: "OFF" });
    expect(audit.errors, JSON.stringify(audit.errors, null, 2)).toEqual([]);
    expect(audit.warnings, JSON.stringify(audit.warnings, null, 2)).toEqual([]);
    const policy = evaluatePolicy(template.graph, { javobAiMode: "OFF", pricePolicy: "NEVER" });
    expect(["PASS", "WARNING"]).toContain(policy.verdict);
    expect(policy.items.filter((i) => i.severity === "BLOCKED")).toEqual([]);
  });

  it("templates stay clean under strict audit contexts (LIVE JavobAI, EXACT prices)", () => {
    for (const t of FLOW_STARTER_TEMPLATES) {
      expect(auditGraph(t.graph, { javobAiMode: "LIVE", pricePolicy: "EXACT" }).errors).toEqual([]);
      expect(evaluatePolicy(t.graph, { javobAiMode: "LIVE" }).verdict).toBe("PASS");
    }
  });

  it("every vars.* used by a template is declared or saved, and the lead templates collect a phone", () => {
    for (const t of FLOW_STARTER_TEMPLATES) {
      const hasLead = t.graph.nodes.some((n) => n.type === "lead");
      if (hasLead) {
        expect(t.graph.nodes.some((n) => n.type === "button" && n.buttons.some((b) => b.kind === "phone" && b.saveAs === "phone"))).toBe(true);
        expect(t.graph.variables.map((v) => v.key)).toContain("phone");
      }
    }
  });
});

describe("AI builder prompt", () => {
  it("builds system + user + schema", () => {
    const prompt = buildFlowBuilderPrompt({
      request: "Komment ostida narx so'raganlarga Direct'da narx va katalog, keyin telefon",
      triggerType: "COMMENT",
      brand: "IELTS markazi",
      kb: ["Kurs narxi 1 200 000 so'm", "Manzil: Chilonzor 5"],
      tags: ["lead", "narx"],
      stages: [{ id: "st1", name: "Yangi" }],
      javobAiLive: false,
    });
    expect(prompt.schemaName).toBe("flow_graph");
    expect(prompt.jsonSchema).toBe(FLOW_BUILDER_JSON_SCHEMA);
    for (const type of ["trigger", "message", "button", "ai", "condition", "delay", "tag", "lead", "webhook", "crm", "operator", "action", "end"]) {
      expect(prompt.system).toContain(`- ${type}:`);
    }
    expect(prompt.system).toContain("tap:<id>");
    expect(prompt.system).toContain("branch:<id>");
    expect(prompt.system).toContain("MISOL 1");
    expect(prompt.system).toContain("MISOL 2");
    expect(prompt.system).toContain("HECH QACHON narx yoki faktni o'ylab topmang");
    expect(prompt.system).toContain("Faqat JSON");
    expect(prompt.user).toContain("Biznes: IELTS markazi");
    expect(prompt.user).toContain("Trigger turi: COMMENT");
    expect(prompt.user).toContain("- Kurs narxi 1 200 000 so'm");
    expect(prompt.user).toContain("stageId: st1");
    expect(prompt.user).toContain("fallback → operator");
    expect(prompt.user).toContain("SO'ROV:");
    const bare = buildFlowBuilderPrompt({ request: "x", javobAiLive: true });
    expect(bare.user).toContain("MA'LUMOTLAR: berilmagan");
    expect(bare.user).toContain("LIVE (ai takeover");
  });

  it("few-shot examples are valid graphs taken from the templates", () => {
    const examples = fewShotExamples();
    expect(examples).toHaveLength(2);
    for (const example of examples) {
      const parsed = JSON.parse(example.json) as { graph: unknown };
      expect(flowGraphSchema.safeParse(parsed.graph).success).toBe(true);
      expect(example.json).not.toContain('"layout"');
    }
  });
});

describe("parseGraphFromLlm", () => {
  const t2 = FLOW_STARTER_TEMPLATES.find((t) => t.key === "story_mention_dm")!;
  const wrapper = { name: "Story oqimi", summary: "Story'da belgilaganlarga taklif", graph: t2.graph };

  it("recovers fenced JSON, bare JSON, prose around JSON and an already parsed object", () => {
    const fenced = "```json\n" + JSON.stringify(wrapper) + "\n```";
    const parsed = parseGraphFromLlm(fenced);
    expect(isFlowParseFailure(parsed)).toBe(false);
    if (!isFlowParseFailure(parsed)) {
      expect(parsed.name).toBe("Story oqimi");
      expect(parsed.summary).toBe("Story'da belgilaganlarga taklif");
      expect(parsed.graph.nodes).toHaveLength(t2.graph.nodes.length);
      expect(parsed.warnings).toEqual([]);
    }
    expect(isFlowParseFailure(parseGraphFromLlm(JSON.stringify(wrapper)))).toBe(false);
    expect(isFlowParseFailure(parseGraphFromLlm("Mana oqim:\n" + JSON.stringify(wrapper) + "\nTayyor."))).toBe(false);
    expect(isFlowParseFailure(parseGraphFromLlm(wrapper))).toBe(false);
    // bare graph without the wrapper
    const bare = parseGraphFromLlm(JSON.stringify(t2.graph));
    expect(isFlowParseFailure(bare)).toBe(false);
    if (!isFlowParseFailure(bare)) expect(bare.name).toBeNull();
  });

  it("accepts [from, to, handle] edge triples and defaults the handle", () => {
    const triples = { ...t2.graph, edges: t2.graph.edges.map((e) => (e.handle === "next" ? [e.from, e.to] : [e.from, e.to, e.handle])) };
    const parsed = parseGraphFromLlm({ graph: triples });
    expect(isFlowParseFailure(parsed)).toBe(false);
  });

  it("reports empty / non-JSON answers", () => {
    expect(parseGraphFromLlm("")).toMatchObject({ error: "empty" });
    expect(parseGraphFromLlm("Kechirasiz, tushunmadim")).toMatchObject({ error: "not_json" });
    expect(parseGraphFromLlm(42)).toMatchObject({ error: "not_json" });
  });

  it("maps common failures to hints: missing trigger, unknown handle, unknown node type", () => {
    const noTrigger = parseGraphFromLlm({ graph: { v: 1, nodes: [{ id: "m1", type: "message", text: "Salom" }, { id: "end", type: "end" }], edges: [["m1", "end"]] } });
    expect(isFlowParseFailure(noTrigger)).toBe(true);
    if (isFlowParseFailure(noTrigger)) {
      expect(noTrigger.error).toBe("invalid_graph");
      expect(noTrigger.hints).toContainEqual(expect.stringContaining("Trigger bloki yo'q"));
    }
    const badHandle = parseGraphFromLlm({
      graph: {
        v: 1,
        nodes: [{ id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY" }, { id: "m1", type: "message", text: "Salom" }, { id: "end", type: "end" }],
        edges: [["t", "m1"], ["m1", "end", "continue"]],
      },
    });
    expect(isFlowParseFailure(badHandle)).toBe(true);
    if (isFlowParseFailure(badHandle)) expect(badHandle.hints).toContainEqual(expect.stringContaining('Noma\'lum chiqish (handle)'));
    const badType = parseGraphFromLlm({ graph: { v: 1, nodes: [{ id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE" }, { id: "x", type: "sms", text: "hi" }], edges: [["t", "x"]] } });
    expect(isFlowParseFailure(badType)).toBe(true);
    if (isFlowParseFailure(badType)) expect(badType.hints.length).toBeGreaterThan(0);
  });

  it("flags undeclared template variables as warnings on an otherwise valid graph", () => {
    const parsed = parseGraphFromLlm({
      graph: {
        v: 1,
        nodes: [{ id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY" }, { id: "m1", type: "message", text: "Narx: {{vars.price}} {{shahar}}" }, { id: "end", type: "end" }],
        edges: [["t", "m1"], ["m1", "end"]],
      },
    });
    expect(isFlowParseFailure(parsed)).toBe(false);
    if (!isFlowParseFailure(parsed)) {
      expect(parsed.warnings).toContainEqual(expect.stringContaining("{{vars.price}} o'zgaruvchisi e'lon qilinmagan"));
      expect(parsed.warnings).toContainEqual(expect.stringContaining("{{shahar}}"));
    }
  });

  it("buildRepairPrompt lists the errors and repeats the previous answer without fences", () => {
    const text = buildRepairPrompt("```json\n{\"graph\":{}}\n```", ["Trigger bloki yo'q", "«m1» blokida \"zap\" chiqishi yo'q"]);
    expect(text).toContain("1. Trigger bloki yo'q");
    expect(text).toContain("2. «m1»");
    expect(text).toContain('{"graph":{}}');
    expect(text).not.toContain("```");
    expect(text).toContain("XUDDI SHU formatda");
  });
});
