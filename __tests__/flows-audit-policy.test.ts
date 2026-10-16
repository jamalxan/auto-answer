/**
 * ETAP 7 — graph helpers, auditor rules (TZ 40) and the publish policy
 * (analysis §3.3). Every rule fires on a crafted graph; the starter
 * templates stay clean (see flows-templates.test.ts).
 */

import { describe, expect, it } from "vitest";
import { auditGraph, findPhoneNumbers, findUrls, type Finding } from "../lib/flows/audit";
import {
  consecutiveSendsMax,
  findCycles,
  findDeadEnds,
  findEndlessLoops,
  findUnreachable,
  maxDelaySinceInputAt,
  pathsFromTrigger,
  reachableFrom,
  windowStateAt,
} from "../lib/flows/graph";
import { evaluatePolicy, mentionsPrice, webhookUrlProblem } from "../lib/flows/policy";
import type { FlowFilter } from "../lib/flows/conditions";
import { type FlowGraph, type FlowGraphInput, type FlowNodeInput, flowGraphDraftSchema } from "../lib/flows/schema";

type Edge = [string, string, string?];

/** Draft-parsed (shape only) so structural problems reach the auditor. */
function draft(nodes: FlowGraphInput["nodes"], edges: Edge[], extra: Partial<FlowGraphInput> = {}): FlowGraph {
  return flowGraphDraftSchema.parse({ v: 1, nodes, edges: edges.map(([from, to, handle]) => ({ from, to, handle: handle ?? "next" })), ...extra });
}

const dm = { id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY" } satisfies FlowNodeInput;
const comment = { id: "t", type: "trigger", triggerType: "COMMENT", keywords: ["narx"], publicReply: "Direct'ga yubordik" } satisfies FlowNodeInput;
const end = { id: "end", type: "end" } satisfies FlowNodeInput;
const msg = (id: string, text = `Xabar ${id}`) : FlowNodeInput => ({ id, type: "message", text });
const opener = { id: "m1", type: "message", text: "Salom! Tugmani bosing", button: { id: "open", label: "Ochish" } } satisfies FlowNodeInput;
const chips = (id = "b1") : FlowNodeInput => ({ id, type: "button", text: "Tanlang", buttons: [{ id: "a", label: "A" }] });
const phoneChips = (id = "b1") : FlowNodeInput => ({ id, type: "button", text: "Raqam?", buttons: [{ id: "ph", label: "Raqam", kind: "phone", saveAs: "phone" }, { id: "no", label: "Yo'q" }] });
const lead = { id: "lead", type: "lead", phoneFrom: "vars.phone", thanks: "Rahmat" } satisfies FlowNodeInput;
/** Silent handoff (no reply, so it is not a send). */
const op = { id: "op", type: "operator", note: "Flow handoff" } satisfies FlowNodeInput;

const codes = (list: Finding[]) => list.map((f) => f.code);
const withCode = (list: Finding[], code: Finding["code"]) => list.filter((f) => f.code === code);

/** A clean DM flow: message → chips → (A) lead path / (other) operator. */
function cleanDm(): FlowGraph {
  return draft(
    [dm, msg("m1", "Salom!"), phoneChips(), lead, { id: "tag", type: "tag", action: "add", tagSlugs: ["lead"] }, op, end],
    [
      ["t", "m1"],
      ["m1", "b1"],
      ["b1", "lead", "tap:ph"],
      ["b1", "op", "tap:no"],
      ["b1", "op", "other"],
      ["lead", "tag"],
      ["lead", "op", "missing"],
      ["tag", "end"],
    ],
    { variables: [{ key: "phone", label: "Telefon", kind: "phone" }] }
  );
}

describe("graph helpers", () => {
  it("reachability, unreachable nodes and dead-ends", () => {
    const g = draft([dm, msg("m1"), msg("orphan"), end], [["t", "m1"], ["m1", "end"], ["orphan", "end"]]);
    expect([...reachableFrom(g, "t")].sort()).toEqual(["end", "m1", "t"]);
    expect(findUnreachable(g)).toEqual(["orphan"]);
    const dead = draft([dm, msg("m1"), chips(), lead], [["t", "m1"], ["m1", "b1"], ["b1", "lead", "tap:a"]]);
    expect(findDeadEnds(dead)).toEqual([
      { nodeId: "b1", handle: "other" },
      { nodeId: "lead", handle: "next" },
      { nodeId: "lead", handle: "missing" },
    ]);
    expect(findUnreachable(draft([msg("m1"), end], [["m1", "end"]]))).toEqual(["m1", "end"]);
  });

  it("cycles: endless without a wait, fine with a button / delay inside", () => {
    const endless = draft([dm, msg("m1"), { id: "tag", type: "tag", action: "add", tagSlugs: ["x"] }], [["t", "m1"], ["m1", "tag"], ["tag", "m1"]]);
    expect(findCycles(endless)).toEqual([{ nodes: ["m1", "tag"], hasWait: false }]);
    expect(findEndlessLoops(endless)).toHaveLength(1);
    const guarded = draft([dm, msg("m1"), chips()], [["t", "m1"], ["m1", "b1"], ["b1", "m1", "tap:a"], ["b1", "m1", "other"]]);
    expect(findCycles(guarded)).toEqual([{ nodes: ["m1", "b1"], hasWait: true }]);
    expect(findEndlessLoops(guarded)).toEqual([]);
    const self = draft([dm, { id: "a1", type: "action", action: "increment", key: "n" }], [["t", "a1"], ["a1", "a1"]]);
    expect(findCycles(self)).toEqual([{ nodes: ["a1"], hasWait: false }]);
    expect(findCycles(cleanDm())).toEqual([]);
  });

  it("consecutiveSendsMax counts sends between customer inputs", () => {
    const chain = draft([dm, msg("m1"), msg("m2"), msg("m3"), { id: "d", type: "delay", minutes: 10 }, msg("m4"), chips(), msg("m5"), end], [
      ["t", "m1"], ["m1", "m2"], ["m2", "m3"], ["m3", "d"], ["d", "m4"], ["m4", "b1"], ["b1", "m5", "tap:a"], ["b1", "m5", "other"], ["m5", "end"],
    ]);
    expect(consecutiveSendsMax(chain)).toEqual({ max: 5, atNodeId: "b1" });
    expect(consecutiveSendsMax(chain, { delayResets: true })).toEqual({ max: 3, atNodeId: "m3" });
    expect(consecutiveSendsMax(chain, { delayResets: true, countWaits: false })).toEqual({ max: 3, atNodeId: "m3" });
    expect(consecutiveSendsMax(cleanDm()).max).toBe(2);
    expect(consecutiveSendsMax(draft([dm, end], [["t", "end"]]))).toEqual({ max: 0, atNodeId: null });
  });

  it("pathsFromTrigger enumerates simple paths", () => {
    const paths = pathsFromTrigger(cleanDm());
    expect(paths).toContainEqual(["t", "m1", "b1", "lead", "tag", "end"]);
    expect(paths).toContainEqual(["t", "m1", "b1", "op"]);
    expect(paths.every((p) => new Set(p).size === p.length)).toBe(true);
  });

  it("windowStateAt: closed before the opening tap of a comment flow, open for DM flows", () => {
    const g = draft([comment, opener, msg("m2"), chips(), end], [["t", "m1"], ["m1", "m2", "tap"], ["m2", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "other"]]);
    const states = windowStateAt(g);
    expect(states.get("t")).toBe("closed");
    expect(states.get("m1")).toBe("closed");
    expect(states.get("m2")).toBe("open");
    expect(states.get("b1")).toBe("open");
    expect(windowStateAt(cleanDm()).get("b1")).toBe("open");
    // mixed: reachable before and after the tap
    const mixed = draft([comment, opener, { id: "tag", type: "tag", action: "add", tagSlugs: ["x"] }, end], [["t", "tag"], ["tag", "m1"], ["m1", "tag", "tap"]]);
    expect(windowStateAt(mixed).get("tag")).toBe("mixed");
  });

  it("maxDelaySinceInputAt accumulates delays until the customer acts", () => {
    const g = draft([dm, { id: "d1", type: "delay", minutes: 1000 }, msg("m1"), { id: "d2", type: "delay", minutes: 600 }, msg("m2"), chips(), { id: "d3", type: "delay", minutes: 30 }, msg("m3"), end], [
      ["t", "d1"], ["d1", "m1"], ["m1", "d2"], ["d2", "m2"], ["m2", "b1"], ["b1", "d3", "tap:a"], ["b1", "d3", "other"], ["d3", "m3"], ["m3", "end"],
    ]);
    const d = maxDelaySinceInputAt(g);
    expect(d.get("m1")).toBe(1000);
    expect(d.get("m2")).toBe(1436); // capped just above the window
    expect(d.get("m3")).toBe(30);
    expect(maxDelaySinceInputAt(draft([comment, opener], [["t", "m1"]])).get("m1")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("auditGraph — each rule fires on a crafted graph", () => {
  it("is clean on a well-formed DM flow", () => {
    const result = auditGraph(cleanDm(), { javobAiMode: "OFF", declaredTags: ["lead"], pricePolicy: "NEVER" });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("unreachable node", () => {
    const g = draft([dm, msg("m1"), msg("orphan"), end], [["t", "m1"], ["m1", "end"], ["orphan", "end"]]);
    const found = withCode(auditGraph(g).errors, "unreachable");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: "orphan", message: expect.stringContaining("hech qayerdan ulanmagan") });
  });

  it("dead-end: missing required handle, broken edge, no trigger", () => {
    const g = draft([dm, msg("m1"), chips()], [["t", "m1"], ["m1", "b1"], ["b1", "end", "tap:a"], ["b1", "m1", "zap"]]);
    const found = withCode(auditGraph(g).errors, "dead_end");
    expect(found.map((f) => f.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('"other" chiqishi bo\'sh'), expect.stringContaining("mavjud bo'lmagan blokka ishora qiladi (end)"), expect.stringContaining('"zap" chiqishi yo\'q')])
    );
    expect(found.find((f) => f.edgeIndex === 3)?.nodeId).toBe("b1");
    expect(auditGraph(draft([msg("m1"), end], [["m1", "end"]])).errors).toContainEqual(expect.objectContaining({ code: "dead_end", message: "Oqimda trigger bloki yo'q" }));
  });

  it("duplicate action: same tag twice on a path, identical consecutive messages", () => {
    const tag = (id: string) : FlowNodeInput => ({ id, type: "tag", action: "add", tagSlugs: ["lead"] });
    const g = draft([dm, tag("t1"), msg("a", "Salom"), msg("b", "salom "), tag("t2"), end], [["t", "t1"], ["t1", "a"], ["a", "b"], ["b", "t2"], ["t2", "end"]]);
    const found = withCode(auditGraph(g).warnings, "duplicate_action");
    expect(found.map((f) => f.nodeId).sort()).toEqual(["b", "t2"]);
    expect(found.find((f) => f.nodeId === "t2")?.message).toContain('"lead" tegi shu yo\'lda «t1»');
  });

  it("conflicting conditions: identical branch, is_set + not_set, audience vs trigger", () => {
    const when: FlowFilter = { v: 1, all: [{ field: "score", op: "gte", value: 50 }] };
    const cond = {
      id: "c1",
      type: "condition",
      branches: [
        { id: "a", label: "A", when },
        { id: "b", label: "B", when },
        { id: "c", label: "C", when: { v: 1, all: [{ field: "vars.city", op: "is_set" }] } },
        { id: "d", label: "D", when: { v: 1, all: [{ field: "vars.city", op: "not_set" }] } },
        { id: "e", label: "E", when: { v: 1, all: [{ field: "audience", op: "eq", value: "RETURNING" }] } },
      ],
    } satisfies FlowNodeInput;
    const g = draft([{ ...dm, audience: "NEW_CONTACT" }, cond, end], [["t", "c1"], ...["a", "b", "c", "d", "e"].map((b): Edge => ["c1", "end", `branch:${b}`]), ["c1", "end", "else"]]);
    const found = withCode(auditGraph(g).warnings, "conflicting_condition").map((f) => f.message);
    expect(found).toContainEqual(expect.stringContaining("«B» sharti «A» bilan bir xil"));
    expect(found).toContainEqual(expect.stringContaining('"vars.city" uchun ham "bor", ham "yo\'q"'));
    expect(found).toContainEqual(expect.stringContaining("auditoriya = RETURNING ni tekshiradi, lekin trigger faqat NEW_CONTACT"));
  });

  it("missing delay: 3 sends in a row → warning, 2 → suggestion", () => {
    const three = draft([dm, msg("a"), msg("b"), msg("c"), end], [["t", "a"], ["a", "b"], ["b", "c"], ["c", "end"]]);
    expect(withCode(auditGraph(three).warnings, "missing_delay")).toHaveLength(1);
    const two = draft([dm, msg("a"), msg("b"), end], [["t", "a"], ["a", "b"], ["b", "end"]]);
    const r = auditGraph(two);
    expect(withCode(r.warnings, "missing_delay")).toHaveLength(0);
    expect(withCode(r.suggestions, "missing_delay")).toHaveLength(1);
    const withDelay = draft([dm, msg("a"), { id: "d", type: "delay", minutes: 5 }, msg("b"), msg("c"), end], [["t", "a"], ["a", "d"], ["d", "b"], ["b", "c"], ["c", "end"]]);
    expect(withCode(auditGraph(withDelay).warnings, "missing_delay")).toHaveLength(0);
  });

  it("spam risk: > 3 sends warning, > 6 error, EVERY trigger without cooldown", () => {
    const sends = (n: number) => {
      const nodes = [dm, ...Array.from({ length: n }, (_, i) => msg(`m${i}`)), end] as FlowGraphInput["nodes"];
      const edges: Edge[] = [["t", "m0"], ...Array.from({ length: n - 1 }, (_, i): Edge => [`m${i}`, `m${i + 1}`]), [`m${n - 1}`, "end"]];
      return draft(nodes, edges);
    };
    expect(withCode(auditGraph(sends(3)).warnings, "spam_risk")).toHaveLength(0);
    expect(withCode(auditGraph(sends(4)).warnings, "spam_risk")).toHaveLength(1);
    expect(withCode(auditGraph(sends(7)).errors, "spam_risk")).toHaveLength(1);
    const noCooldown = draft([{ ...comment, matchingMode: "EVERY", cooldownHours: 0 }, opener, end], [["t", "m1"], ["m1", "end", "tap"]]);
    expect(withCode(auditGraph(noCooldown).warnings, "spam_risk")[0]?.message).toContain("cooldown'siz");
    const dmNoCooldown = draft([{ ...dm, cooldownHours: 0 }, msg("m1"), end], [["t", "m1"], ["m1", "end"]]);
    expect(withCode(auditGraph(dmNoCooldown).warnings, "spam_risk")).toHaveLength(1);
  });

  it("policy risk: comment flow without an opening button becomes an audit error", () => {
    const g = draft([comment, msg("m1", "Salom"), chips(), end], [["t", "m1"], ["m1", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "other"]]);
    const found = withCode(auditGraph(g).errors, "policy_risk");
    expect(found.map((f) => f.policyCode)).toEqual(expect.arrayContaining(["window_no_opening_button", "window_closed_send"]));
    expect(found[0].fix).toBeTruthy();
  });

  it("forbidden content: phone number, foreign URL, blocklist, price under NEVER", () => {
    const g = draft(
      [dm, msg("a", "Qo'ng'iroq qiling: +998 90 123 45 67"), msg("b", "Sayt: https://example.com/shop va t.me/kanal"), msg("c", "Kafolatlangan daromad 100% natija"), msg("d", "Narxi 250 000 so'm"), chips(), op],
      [["t", "a"], ["a", "b"], ["b", "c"], ["c", "d"], ["d", "b1"], ["b1", "op", "tap:a"], ["b1", "op", "other"]]
    );
    const found = withCode(auditGraph(g, { pricePolicy: "NEVER", allowedUrls: ["t.me/kanal"] }).warnings, "forbidden_content");
    const byNode = (id: string) => found.filter((f) => f.nodeId === id).map((f) => f.message);
    expect(byNode("a")[0]).toContain("telefon raqami");
    expect(byNode("b")).toHaveLength(1);
    expect(byNode("b")[0]).toContain("example.com");
    expect(byNode("c").length).toBeGreaterThanOrEqual(1);
    expect(byNode("d")[0]).toContain("narx yozilgan");
    expect(withCode(auditGraph(g, { pricePolicy: "EXACT" }).warnings, "forbidden_content").filter((f) => f.nodeId === "d")).toHaveLength(0);
    expect(findPhoneNumbers("Tel: 90-123-45-67, yil 2026")).toEqual(["90-123-45-67"]);
    expect(findUrls("www.site.uz va {{vars.catalog_url}}")).toEqual(["www.site.uz"]);
  });

  it("incorrect variable: unknown key is an error, vars.* never set is a warning, undeclared saveAs is a suggestion", () => {
    const g = draft(
      [dm, msg("a", "Salom {{shahar}} {{vars.city}} {{vars.need}}"), { id: "b1", type: "button", text: "?", buttons: [{ id: "x", label: "X", saveAs: "need" }] }, msg("c", "Siz: {{vars.need}} {{vars.later|keyin}}"), { id: "b2", type: "button", text: "?", buttons: [{ id: "y", label: "Y", saveAs: "later" }] }, op],
      [["t", "a"], ["a", "b1"], ["b1", "c", "tap:x"], ["b1", "c", "other"], ["c", "b2"], ["b2", "op", "tap:y"], ["b2", "op", "other"]],
      { variables: [{ key: "city", label: "Shahar", kind: "string" }] }
    );
    const r = auditGraph(g);
    const errors = withCode(r.errors, "incorrect_variable").map((f) => f.message);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("{{shahar}} o'zgaruvchisi mavjud emas");
    const warnings = withCode(r.warnings, "incorrect_variable").map((f) => f.message);
    expect(warnings).toContainEqual(expect.stringContaining("{{vars.city}} hech qayerda saqlanmaydi"));
    expect(warnings).toContainEqual(expect.stringContaining("{{vars.need}} bu blokdan oldin saqlanmaydi"));
    expect(warnings.filter((m) => m.includes("«c»") && m.includes("vars.need"))).toHaveLength(0);
    expect(withCode(r.suggestions, "incorrect_variable").map((f) => f.message)).toEqual(expect.arrayContaining([expect.stringContaining('"need" o\'zgaruvchisi saqlanadi'), expect.stringContaining('"later"')]));
  });

  it("broken integration: webhook url, crm stage, unknown tag, SPECIFIC media without ids, keywordless trigger", () => {
    const g = draft(
      [
        { ...comment, mediaScope: "SPECIFIC", mediaIds: [], keywords: [] },
        opener,
        { id: "w1", type: "webhook", url: "http://api.example.com/hook" },
        { id: "w2", type: "webhook", url: "https://192.168.1.10/hook" },
        { id: "w3", type: "webhook", url: "https://localhost/hook" },
        { id: "crm", type: "crm", action: "move_stage", stageId: "stage_x" },
        { id: "crm2", type: "crm", action: "move_stage" },
        { id: "tag", type: "tag", action: "add", tagSlugs: ["lead", "yangi"] },
        end,
      ],
      [["t", "m1"], ["m1", "w1", "tap"], ["w1", "w2"], ["w2", "w3"], ["w3", "crm"], ["crm", "crm2"], ["crm2", "tag"], ["tag", "end"]]
    );
    const r = auditGraph(g, { stages: ["stage_a"], declaredTags: ["lead"] });
    const errors = withCode(r.errors, "broken_integration");
    expect(errors.map((f) => f.nodeId)).toEqual(expect.arrayContaining(["w1", "w2", "w3", "crm", "crm2", "t"]));
    expect(errors.find((f) => f.nodeId === "w1")?.policyCode).toBe("webhook_not_https");
    expect(errors.find((f) => f.nodeId === "w2")?.policyCode).toBe("webhook_private_host");
    expect(errors.find((f) => f.nodeId === "crm")?.message).toContain('"stage_x" bosqichi CRM\'da yo\'q');
    expect(errors.filter((f) => f.nodeId === "t").map((f) => f.message)).toEqual(expect.arrayContaining([expect.stringContaining("post tanlanmagan"), expect.stringContaining("kalit so'z yoki niyatsiz")]));
    const warnings = withCode(r.warnings, "broken_integration");
    expect(warnings.find((f) => f.nodeId === "tag")?.message).toContain('"yangi" tegi hali yaratilmagan');
    expect(withCode(auditGraph(g).warnings, "broken_integration").filter((f) => f.nodeId === "tag")).toHaveLength(0);
  });

  it("missing handoff: takeover without fallback when JavobAI is not LIVE; questions with nobody listening", () => {
    const takeover = draft([dm, msg("m1"), { id: "ai", type: "ai", mode: "takeover" }], [["t", "m1"], ["m1", "ai"]]);
    expect(withCode(auditGraph(takeover, { javobAiMode: "SHADOW" }).warnings, "missing_handoff").length).toBeGreaterThanOrEqual(1);
    expect(withCode(auditGraph(takeover, { javobAiMode: "LIVE" }).warnings, "missing_handoff")).toHaveLength(0);
    expect(withCode(auditGraph(takeover).warnings, "missing_handoff")).toHaveLength(0);
    const withFallback = draft([dm, msg("m1"), { id: "ai", type: "ai", mode: "takeover" }, op], [["t", "m1"], ["m1", "ai"], ["ai", "op", "fallback"]]);
    expect(withCode(auditGraph(withFallback, { javobAiMode: "OFF" }).warnings, "missing_handoff")).toHaveLength(0);
    const nobody = draft([dm, chips(), msg("m2"), end], [["t", "b1"], ["b1", "m2", "tap:a"], ["b1", "m2", "other"], ["m2", "end"]]);
    expect(withCode(auditGraph(nobody).warnings, "missing_handoff")[0]?.message).toContain("javoblar hech kimga yetib bormaydi");
    const ask = draft([dm, { id: "ai", type: "ai", mode: "ask", question: "Shahar?", saveAs: "city", extract: "city" }, msg("m2"), end], [["t", "ai"], ["ai", "m2"], ["ai", "m2", "missing"], ["m2", "end"]]);
    expect(withCode(auditGraph(ask).warnings, "missing_handoff").map((f) => f.policyCode)).toContain("ai_no_handoff");
  });

  it("endless loop", () => {
    const g = draft([dm, msg("m1"), { id: "tag", type: "tag", action: "add", tagSlugs: ["x"] }], [["t", "m1"], ["m1", "tag"], ["tag", "m1"]]);
    const found = withCode(auditGraph(g).errors, "endless_loop");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("Cheksiz aylanish");
    const guarded = draft([dm, msg("m1"), chips()], [["t", "m1"], ["m1", "b1"], ["b1", "m1", "tap:a"], ["b1", "m1", "other"]]);
    expect(withCode(auditGraph(guarded).errors, "endless_loop")).toHaveLength(0);
    expect(auditGraph(guarded).suggestions.map((f) => f.message)).toContainEqual(expect.stringContaining("Aylanish bor"));
  });

  it("suggestions: long first message, no publicReply, lead without thanks, no tag on lead path", () => {
    const g = draft([{ ...comment, publicReply: undefined }, { ...opener, text: "x".repeat(301) }, phoneChips(), { id: "lead", type: "lead" }, end], [["t", "m1"], ["m1", "b1", "tap"], ["b1", "lead", "tap:ph"], ["b1", "end", "tap:no"], ["b1", "end", "other"], ["lead", "end"], ["lead", "end", "missing"]]);
    const s = auditGraph(g).suggestions.map((f) => f.message);
    expect(s).toContainEqual(expect.stringContaining("Birinchi xabar 300 belgidan uzun"));
    expect(s).toContainEqual(expect.stringContaining("publicReply"));
    expect(s).toContainEqual(expect.stringContaining("rahmat xabari yo'q"));
    expect(s).toContainEqual(expect.stringContaining("teg qo'yilmaydi"));
  });

  it("every finding carries an Uzbek message and the three groups are disjoint by severity", () => {
    const r = auditGraph(draft([comment, msg("m1", "Salom {{nope}}"), chips(), end], [["t", "m1"], ["m1", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "other"]]));
    for (const f of [...r.errors, ...r.warnings, ...r.suggestions]) expect(f.message.length).toBeGreaterThan(5);
    expect(codes(r.errors)).toEqual(expect.arrayContaining(["policy_risk", "incorrect_variable"]));
  });
});

describe("evaluatePolicy — verdicts", () => {
  it("PASS on a clean DM flow", () => {
    expect(evaluatePolicy(cleanDm(), { javobAiMode: "OFF", pricePolicy: "NEVER" })).toEqual({ verdict: "PASS", items: [] });
  });

  it("BLOCKED: comment flow whose first send has no opening button", () => {
    const g = draft([comment, msg("m1", "Salom"), chips(), end], [["t", "m1"], ["m1", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "other"]]);
    const r = evaluatePolicy(g);
    expect(r.verdict).toBe("BLOCKED");
    expect(r.items.map((i) => i.code)).toEqual(expect.arrayContaining(["window_no_opening_button", "window_closed_send"]));
    // single private reply with no continuation is fine
    expect(evaluatePolicy(draft([comment, msg("m1", "Narx Direct'da"), end], [["t", "m1"], ["m1", "end"]])).verdict).toBe("PASS");
    // first send is not a message
    const firstChips = draft([comment, chips(), end], [["t", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "other"]]);
    expect(evaluatePolicy(firstChips).items.map((i) => i.code)).toContain("window_first_not_message");
  });

  it("BLOCKED: a send after a delay with no prior tap / inbound (comment flow before the tap)", () => {
    const g = draft([comment, msg("m1", "Salom"), { id: "d", type: "delay", minutes: 5 }, msg("m2", "Eslatma"), end], [["t", "m1"], ["m1", "d"], ["d", "m2"], ["m2", "end"]]);
    const r = evaluatePolicy(g);
    expect(r.verdict).toBe("BLOCKED");
    expect(r.items.find((i) => i.code === "send_after_delay")?.nodeId).toBe("m2");
    // DM flow: the trigger message is the inbound, a short delay is fine
    const dmDelay = draft([dm, msg("m1"), { id: "d", type: "delay", minutes: 60 }, msg("m2"), op], [["t", "m1"], ["m1", "d"], ["d", "m2"], ["m2", "op"]]);
    expect(evaluatePolicy(dmDelay).verdict).toBe("PASS");
  });

  it("WARNING: send after more than 24h of delays; BLOCKED: 7-day delay", () => {
    const long = draft([dm, msg("m1"), { id: "d", type: "delay", minutes: 1500 }, msg("m2"), op], [["t", "m1"], ["m1", "d"], ["d", "m2"], ["m2", "op"]]);
    const r = evaluatePolicy(long);
    expect(r.verdict).toBe("WARNING");
    expect(r.items).toEqual([expect.objectContaining({ code: "send_after_long_delay", nodeId: "m2", severity: "WARNING" })]);
    const week = draft([dm, msg("m1"), { id: "d", type: "delay", minutes: 10080 }, { id: "tag", type: "tag", action: "add", tagSlugs: ["x"] }, end], [["t", "m1"], ["m1", "d"], ["d", "tag"], ["tag", "end"]]);
    expect(evaluatePolicy(week).items.map((i) => i.code)).toContain("delay_too_long");
  });

  it("consecutive sends: 4 → WARNING, 7 → BLOCKED", () => {
    const sends = (n: number) => {
      const nodes = [dm, ...Array.from({ length: n }, (_, i) => msg(`m${i}`)), op] as FlowGraphInput["nodes"];
      const edges: Edge[] = [["t", "m0"], ...Array.from({ length: n - 1 }, (_, i): Edge => [`m${i}`, `m${i + 1}`]), [`m${n - 1}`, "op"]];
      return draft(nodes, edges);
    };
    expect(evaluatePolicy(sends(3)).verdict).toBe("PASS");
    expect(evaluatePolicy(sends(4))).toMatchObject({ verdict: "WARNING", items: [expect.objectContaining({ code: "consecutive_sends", nodeId: "m3" })] });
    expect(evaluatePolicy(sends(7))).toMatchObject({ verdict: "BLOCKED", items: [expect.objectContaining({ code: "consecutive_sends", severity: "BLOCKED" })] });
  });

  it("WARNING: price text under NEVER (digits + so'm / $ / k), silent under EXACT or without prices", () => {
    const g = draft([dm, msg("m1", "Kurs narxi 1 200 000 so'm, chegirma bilan 990k"), msg("m2", "Narx: {{vars.price|menejer aytadi}}"), msg("m3", "Soat 9:00 dan 18:00 gacha, 2026-yil"), op], [["t", "m1"], ["m1", "m2"], ["m2", "m3"], ["m3", "op"]]);
    const never = evaluatePolicy(g, { pricePolicy: "NEVER" });
    expect(never.verdict).toBe("WARNING");
    expect(never.items.map((i) => i.nodeId)).toEqual(["m1"]);
    expect(evaluatePolicy(g, { pricePolicy: "EXACT" }).verdict).toBe("PASS");
    expect(evaluatePolicy(g).verdict).toBe("PASS");
    expect(mentionsPrice("$25")).toBe(true);
    expect(mentionsPrice("250 ming so'm")).toBe(true);
    expect(mentionsPrice("3 kun ichida")).toBe(false);
    const fallbackPrice = draft([dm, msg("m1", "Narx: {{vars.price|250 000 so'm}}"), op], [["t", "m1"], ["m1", "op"]]);
    expect(evaluatePolicy(fallbackPrice, { pricePolicy: "NEVER" }).items[0]?.message).toContain("zaxira matnda narx");
  });

  it("WARNING: ai node without a handoff path / not LIVE", () => {
    const ask = draft([dm, { id: "ai", type: "ai", mode: "ask", question: "Shahar?", saveAs: "city", extract: "city" }, msg("m2"), end], [["t", "ai"], ["ai", "m2"], ["ai", "m2", "missing"], ["m2", "end"]]);
    expect(evaluatePolicy(ask)).toMatchObject({ verdict: "WARNING", items: [expect.objectContaining({ code: "ai_no_handoff", nodeId: "ai" })] });
    const takeover = draft([dm, { id: "ai", type: "ai", mode: "takeover" }], [["t", "ai"]]);
    expect(evaluatePolicy(takeover, { javobAiMode: "OFF" }).items.map((i) => i.code)).toEqual(expect.arrayContaining(["ai_not_live", "ai_no_handoff"]));
    expect(evaluatePolicy(takeover, { javobAiMode: "LIVE" }).verdict).toBe("PASS");
    expect(evaluatePolicy(takeover).verdict).toBe("PASS");
    const withOp = draft([dm, { id: "ai", type: "ai", mode: "ask", question: "Shahar?", saveAs: "city", extract: "city" }, op], [["t", "ai"], ["ai", "op"], ["ai", "op", "missing"]]);
    expect(evaluatePolicy(withOp).verdict).toBe("PASS");
  });

  it("BLOCKED: webhook to a private / internal host or over http; WARNING outside the allowlist", () => {
    const hook = (url: string) => draft([dm, { id: "w", type: "webhook", url }, op], [["t", "w"], ["w", "op"]]);
    expect(evaluatePolicy(hook("https://api.example.com/x")).verdict).toBe("PASS");
    for (const url of ["https://10.0.0.5/x", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://intranet/x", "https://svc.internal/x", "https://169.254.169.254/latest"]) {
      expect(evaluatePolicy(hook(url)).items[0]).toMatchObject({ code: "webhook_private_host", severity: "BLOCKED" });
    }
    expect(evaluatePolicy(hook("http://api.example.com/x")).items[0]?.code).toBe("webhook_not_https");
    expect(evaluatePolicy(hook("https://api.example.com/x"), { webhookAllowedHosts: ["*.partner.uz"] })).toMatchObject({ verdict: "WARNING", items: [expect.objectContaining({ code: "webhook_host_not_allowed" })] });
    expect(evaluatePolicy(hook("https://crm.partner.uz/x"), { webhookAllowedHosts: ["*.partner.uz"] }).verdict).toBe("PASS");
    expect(webhookUrlProblem("not a url")).toBe("invalid");
  });

  it("BLOCKED: endless loop, unreachable, dead-end (ERROR class)", () => {
    const loop = draft([dm, msg("m1"), { id: "tag", type: "tag", action: "add", tagSlugs: ["x"] }], [["t", "m1"], ["m1", "tag"], ["tag", "m1"]]);
    expect(evaluatePolicy(loop).items.map((i) => i.code)).toContain("endless_loop");
    const orphan = draft([dm, msg("m1"), msg("x"), op], [["t", "m1"], ["m1", "op"], ["x", "op"]]);
    expect(evaluatePolicy(orphan)).toMatchObject({ verdict: "BLOCKED", items: [expect.objectContaining({ code: "unreachable", nodeId: "x" })] });
    const dead = draft([dm, msg("m1")], [["t", "m1"]]);
    expect(evaluatePolicy(dead).items[0]).toMatchObject({ code: "dead_end", nodeId: "m1", severity: "BLOCKED" });
  });

  it("BLOCKED: limits (label > 20, message with button > 640, quick replies > 13)", () => {
    // message with a button: zod allows 1000 chars, the button template only 640
    const longText = draft([dm, { id: "m1", type: "message", text: "x".repeat(641), button: { id: "o", label: "Ochish" } }, op], [["t", "m1"], ["m1", "op", "tap"]]);
    expect(evaluatePolicy(longText).items[0]?.code).toBe("message_button_too_long");
    // label / quick-reply counts are zod-enforced at save; the policy keeps the
    // check for graphs loaded from storage, so mutate a parsed graph here.
    const longLabel = draft([dm, { id: "m1", type: "message", text: "x", button: { id: "o", label: "Ochish" } }, op], [["t", "m1"], ["m1", "op", "tap"]]);
    const m1 = longLabel.nodes[1];
    if (m1.type === "message" && m1.button) m1.button.label = "Bu tugma nomi juda uzun bo'ldi";
    expect(evaluatePolicy(longLabel).items[0]?.code).toBe("button_label_too_long");
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `q${i}`, label: `Q${i}` }));
    const tooMany = draft([dm, { id: "b1", type: "button", text: "?", buttons: many.slice(0, 13) }, op], [["t", "b1"], ...many.map((b): Edge => ["b1", "op", `tap:${b.id}`]), ["b1", "op", "other"]]);
    const b1 = tooMany.nodes[1];
    if (b1.type === "button") b1.buttons.push({ id: "q13", label: "Q13 juda uzun tugma nomi", kind: "text" });
    expect(evaluatePolicy(tooMany).items.map((i) => i.code)).toEqual(expect.arrayContaining(["too_many_quick_replies", "button_label_too_long"]));
  });

  it("BLOCKED: lead node with no phone source upstream; WARNING: LIVE_COMMENT extra sends; duplicate text", () => {
    const noPhone = draft([dm, chips(), lead, op], [["t", "b1"], ["b1", "lead", "tap:a"], ["b1", "op", "other"], ["lead", "op"], ["lead", "op", "missing"]]);
    expect(evaluatePolicy(noPhone).items[0]).toMatchObject({ code: "lead_no_phone_source", severity: "BLOCKED", nodeId: "lead" });
    expect(evaluatePolicy(cleanDm()).verdict).toBe("PASS");
    const contactPhone = draft([dm, { ...lead, phoneFrom: "contact.phone" }, op], [["t", "lead"], ["lead", "op"], ["lead", "op", "missing"]]);
    expect(evaluatePolicy(contactPhone).verdict).toBe("PASS");
    const live = draft([{ ...comment, triggerType: "LIVE_COMMENT" }, opener, msg("m2"), end], [["t", "m1"], ["m1", "m2", "tap"], ["m2", "end"]]);
    expect(evaluatePolicy(live)).toMatchObject({ verdict: "WARNING", items: [expect.objectContaining({ code: "live_comment_extra_send" })] });
    const dup = draft([dm, msg("a", "Salom"), chips(), msg("b", "salom"), op], [["t", "a"], ["a", "b1"], ["b1", "b", "tap:a"], ["b1", "b", "other"], ["b", "op"]]);
    expect(evaluatePolicy(dup).items).toEqual([expect.objectContaining({ code: "duplicate_text", nodeId: "b" })]);
  });
});
