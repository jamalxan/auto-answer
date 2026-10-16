/**
 * ETAP 6 — flow graph schema: shape, handle table and structural checks.
 */

import { describe, expect, it } from "vitest";
import {
  FLOW_NODE_TYPES,
  type FlowGraphInput,
  type FlowNode,
  type FlowNodeInput,
  flowGraphDraftSchema,
  flowGraphSchema,
  formatIssues,
  HANDLE_RULES,
  handlesFor,
  isSendNode,
  isUserWaitNode,
  NODE_LABELS,
  parseFlowGraph,
  structuralIssues,
  templateFields,
} from "../lib/flows/schema";

type Edge = [string, string, string?];

function graph(nodes: FlowGraphInput["nodes"], edges: Edge[], extra: Partial<FlowGraphInput> = {}): FlowGraphInput {
  return { v: 1, nodes, edges: edges.map(([from, to, handle]) => ({ from, to, handle: handle ?? "next" })), ...extra };
}

const dmTrigger = { id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY" } satisfies FlowNodeInput;
const commentTrigger = { id: "t", type: "trigger", triggerType: "COMMENT", keywords: ["narx"] } satisfies FlowNodeInput;

function issuesOf(input: FlowGraphInput): string[] {
  const parsed = flowGraphSchema.safeParse(input);
  return parsed.success ? [] : formatIssues(parsed.error);
}

describe("flowGraphSchema — shape", () => {
  it("accepts a minimal DM flow and fills defaults", () => {
    const parsed = flowGraphSchema.parse(
      graph(
        [dmTrigger, { id: "m1", type: "message", text: "Salom" }, { id: "end", type: "end" }],
        [
          ["t", "m1"],
          ["m1", "end"],
        ]
      )
    );
    const trigger = parsed.nodes[0];
    expect(trigger.type === "trigger" && trigger.cooldownHours).toBe(24);
    expect(trigger.type === "trigger" && trigger.audience).toBe("ANY");
    expect(parsed.variables).toEqual([]);
    expect(parsed.edges[0].handle).toBe("next");
  });

  it("rejects bad ids, long labels, too many quick replies and unknown node types", () => {
    expect(parseFlowGraph(graph([{ ...dmTrigger, id: "Bad-Id" }, { id: "end", type: "end" }], [["Bad-Id", "end"]]))).toBeNull();
    expect(
      parseFlowGraph(
        graph(
          [dmTrigger, { id: "m1", type: "message", text: "x", button: { id: "b", label: "Bu tugma nomi juda uzun bo'ldi" } }, { id: "end", type: "end" }],
          [
            ["t", "m1"],
            ["m1", "end", "tap"],
          ]
        )
      )
    ).toBeNull();
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `q${i}`, label: `Q${i}` }));
    expect(parseFlowGraph(graph([dmTrigger, { id: "b1", type: "button", text: "?", buttons: many }, { id: "end", type: "end" }], [["t", "b1"], ["b1", "end", "other"]]))).toBeNull();
    expect(parseFlowGraph({ v: 1, nodes: [dmTrigger, { id: "x", type: "sms" }], edges: [] })).toBeNull();
    expect(parseFlowGraph({ v: 2, nodes: [dmTrigger, { id: "end", type: "end" }], edges: [{ from: "t", to: "end" }] })).toBeNull();
  });

  it("the draft schema accepts an incomplete graph that the strict schema rejects", () => {
    const draft = graph([dmTrigger, { id: "m1", type: "message", text: "Salom" }], [["t", "m1"]]);
    expect(flowGraphDraftSchema.safeParse(draft).success).toBe(true);
    expect(flowGraphSchema.safeParse(draft).success).toBe(false);
  });
});

describe("flowGraphSchema — structural checks", () => {
  it("requires exactly one trigger", () => {
    expect(issuesOf(graph([{ id: "m1", type: "message", text: "x" }, { id: "end", type: "end" }], [["m1", "end"]]))).toContainEqual(expect.stringContaining("aynan bitta trigger"));
    expect(issuesOf(graph([dmTrigger, { ...dmTrigger, id: "t2" }, { id: "end", type: "end" }], [["t", "end"], ["t2", "end"]]))).toContainEqual(expect.stringContaining("aynan bitta trigger"));
  });

  it("requires unique node ids and unique variable keys", () => {
    expect(issuesOf(graph([dmTrigger, { id: "end", type: "end" }, { id: "end", type: "end" }], [["t", "end"]]))).toContainEqual(expect.stringContaining("takrorlangan: end"));
    const vars = [
      { key: "phone", label: "T", kind: "phone" as const },
      { key: "phone", label: "T2", kind: "string" as const },
    ];
    expect(issuesOf(graph([dmTrigger, { id: "end", type: "end" }], [["t", "end"]], { variables: vars }))).toContainEqual(expect.stringContaining("O'zgaruvchi takrorlangan"));
  });

  it("edges must reference existing nodes, never enter the trigger, and use a known handle once", () => {
    const base: FlowNodeInput[] = [dmTrigger, { id: "m1", type: "message", text: "x" }, { id: "end", type: "end" }];
    expect(issuesOf(graph([...base], [["t", "m1"], ["m1", "nope"]]))).toContainEqual(expect.stringContaining("mavjud bo'lmagan blokka kiradi: nope"));
    expect(issuesOf(graph([...base], [["ghost", "m1"], ["t", "m1"], ["m1", "end"]]))).toContainEqual(expect.stringContaining("mavjud bo'lmagan blokdan chiqadi: ghost"));
    expect(issuesOf(graph([...base], [["t", "m1"], ["m1", "t"]]))).toContainEqual(expect.stringContaining("Trigger blokiga bog'lanish"));
    expect(issuesOf(graph([...base], [["t", "m1"], ["m1", "end", "tap:zzz"]]))).toContainEqual(expect.stringContaining('"tap:zzz" chiqishi yo\'q'));
    expect(issuesOf(graph([...base], [["t", "m1"], ["m1", "end"], ["m1", "end"]]))).toContainEqual(expect.stringContaining("ikki marta bog'langan"));
  });

  it("requires every required handle (dead-end) per node type", () => {
    const button = { id: "b1", type: "button", text: "?", buttons: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } satisfies FlowNodeInput;
    const end = { id: "end", type: "end" } satisfies FlowNodeInput;
    // button: tap:<id> for every button + other
    expect(issuesOf(graph([dmTrigger, button, end], [["t", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "other"]]))).toContainEqual(expect.stringContaining('"tap:b" chiqishi bog\'lanmagan'));
    expect(issuesOf(graph([dmTrigger, button, end], [["t", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "tap:b"]]))).toContainEqual(expect.stringContaining('"other" chiqishi bog\'lanmagan'));
    // condition: branch:<id> + else
    const cond = { id: "c1", type: "condition", branches: [{ id: "x", label: "X", when: { v: 1, all: [{ field: "score", op: "gte", value: 50 }] } }] } satisfies FlowNodeInput;
    expect(issuesOf(graph([dmTrigger, cond, end], [["t", "c1"], ["c1", "end", "branch:x"]]))).toContainEqual(expect.stringContaining('"else" chiqishi bog\'lanmagan'));
    // lead: next + missing
    const lead = { id: "lead", type: "lead" } satisfies FlowNodeInput;
    const phoneBtn = { id: "b1", type: "button", text: "?", buttons: [{ id: "ph", label: "Tel", kind: "phone", saveAs: "phone" }] } satisfies FlowNodeInput;
    expect(issuesOf(graph([dmTrigger, phoneBtn, lead, end], [["t", "b1"], ["b1", "lead", "tap:ph"], ["b1", "end", "other"], ["lead", "end"]]))).toContainEqual(expect.stringContaining('"missing" chiqishi bog\'lanmagan'));
    // ai.ask: next + missing
    const ask = { id: "ai1", type: "ai", mode: "ask", question: "Shahar?", saveAs: "city", extract: "city" } satisfies FlowNodeInput;
    expect(issuesOf(graph([dmTrigger, ask, end], [["t", "ai1"], ["ai1", "end"]]))).toContainEqual(expect.stringContaining('"missing" chiqishi bog\'lanmagan'));
    // ai.takeover: terminal, fallback optional
    const takeover = { id: "ai1", type: "ai", mode: "takeover" } satisfies FlowNodeInput;
    expect(issuesOf(graph([dmTrigger, takeover], [["t", "ai1"]]))).toEqual([]);
    expect(issuesOf(graph([dmTrigger, takeover, { id: "op", type: "operator" }], [["t", "ai1"], ["ai1", "op", "fallback"]]))).toEqual([]);
    expect(issuesOf(graph([dmTrigger, ask, end], [["t", "ai1"], ["ai1", "end"], ["ai1", "end", "missing"], ["ai1", "end", "fallback"]]))).toContainEqual(expect.stringContaining('"fallback" chiqishi taqiqlangan'));
    // operator: terminal with optional next; end: no outgoing
    expect(issuesOf(graph([dmTrigger, { id: "op", type: "operator", reply: "Hozir" }], [["t", "op"]]))).toEqual([]);
    expect(issuesOf(graph([dmTrigger, end, { id: "m1", type: "message", text: "x" }], [["t", "end"], ["end", "m1"], ["m1", "end"]]))).toContainEqual(expect.stringContaining('"next" chiqishi taqiqlangan'));
    // delay: next (+ optional window_closed); webhook: next (+ optional error)
    expect(issuesOf(graph([dmTrigger, { id: "d", type: "delay", minutes: 5 }, end], [["t", "d"], ["d", "end"], ["d", "end", "window_closed"]]))).toEqual([]);
    expect(issuesOf(graph([dmTrigger, { id: "w", type: "webhook", url: "https://api.example.com/x" }, end], [["t", "w"], ["w", "end"], ["w", "end", "error"]]))).toEqual([]);
    // button timeout only when timeoutMinutes is set
    expect(issuesOf(graph([dmTrigger, button, end], [["t", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "tap:b"], ["b1", "end", "other"], ["b1", "end", "timeout"]]))).toContainEqual(expect.stringContaining('"timeout" chiqishi taqiqlangan'));
    expect(issuesOf(graph([dmTrigger, { ...button, timeoutMinutes: 60 }, end], [["t", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "tap:b"], ["b1", "end", "other"], ["b1", "end", "timeout"]]))).toEqual([]);
  });

  it("a message with a button has only `tap` (no `next`), without a button only `next`", () => {
    const withButton = { id: "m1", type: "message", text: "x", button: { id: "b", label: "Ochish" } } satisfies FlowNodeInput;
    const end = { id: "end", type: "end" } satisfies FlowNodeInput;
    expect(issuesOf(graph([dmTrigger, withButton, end], [["t", "m1"], ["m1", "end", "tap"]]))).toEqual([]);
    const withNext = issuesOf(graph([dmTrigger, withButton, end], [["t", "m1"], ["m1", "end", "next"]]));
    expect(withNext).toContainEqual(expect.stringContaining('"next" chiqishi taqiqlangan'));
    expect(withNext).toContainEqual(expect.stringContaining('"tap" chiqishi bog\'lanmagan'));
    expect(issuesOf(graph([dmTrigger, { id: "m1", type: "message", text: "x" }, end], [["t", "m1"], ["m1", "end", "tap"]]))).toContainEqual(expect.stringContaining('"tap" chiqishi taqiqlangan'));
  });

  describe("24h window for comment triggers", () => {
    const end = { id: "end", type: "end" } satisfies FlowNodeInput;
    const opener = { id: "m1", type: "message", text: "Salom! Tugmani bosing", button: { id: "open", label: "Narxni ko'rish" } } satisfies FlowNodeInput;
    const chips = { id: "b1", type: "button", text: "Tanlang", buttons: [{ id: "a", label: "A" }] } satisfies FlowNodeInput;

    it("accepts: private reply with a button, everything else behind its tap", () => {
      expect(issuesOf(graph([commentTrigger, opener, { id: "m2", type: "message", text: "Narx: 100" }, chips, end], [["t", "m1"], ["m1", "m2", "tap"], ["m2", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "other"]]))).toEqual([]);
    });

    it("accepts a single private reply without a button that just ends", () => {
      expect(issuesOf(graph([commentTrigger, { id: "m1", type: "message", text: "Narx Direct'da" }, { id: "tag", type: "tag", action: "add", tagSlugs: ["narx"] }, end], [["t", "m1"], ["m1", "tag"], ["tag", "end"]]))).toEqual([]);
    });

    it("rejects a second send before the tap", () => {
      const issues = issuesOf(graph([commentTrigger, { id: "m1", type: "message", text: "Bir" }, { id: "m2", type: "message", text: "Ikki" }, end], [["t", "m1"], ["m1", "m2"], ["m2", "end"]]));
      expect(issues).toContainEqual(expect.stringContaining("«m2» ikkinchi xabar sifatida yuborilmaydi"));
    });

    it("rejects button / ai / lead / delay reachable before the window opens", () => {
      expect(issuesOf(graph([commentTrigger, chips, end], [["t", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "other"]]))).toContainEqual(expect.stringContaining("«b1» (Tugmalar) bloki oyna ochilmasdan"));
      expect(issuesOf(graph([commentTrigger, { id: "d", type: "delay", minutes: 60 }, opener, end], [["t", "d"], ["d", "m1"], ["m1", "end", "tap"]]))).toContainEqual(expect.stringContaining("«d» (Kutish) bloki oyna ochilmasdan"));
      expect(issuesOf(graph([commentTrigger, { id: "ai1", type: "ai", mode: "takeover" }], [["t", "ai1"]]))).toContainEqual(expect.stringContaining("«ai1» (JavobAI) bloki oyna ochilmasdan"));
      expect(issuesOf(graph([commentTrigger, { id: "m1", type: "message", text: "x" }, { id: "lead", type: "lead" }, end], [["t", "m1"], ["m1", "lead"], ["lead", "end"], ["lead", "end", "missing"]]))).toContainEqual(expect.stringContaining("«lead» (Lead) bloki oyna ochilmasdan"));
    });

    it("a condition before the first message is fine as long as each path sends once", () => {
      const cond = { id: "c1", type: "condition", branches: [{ id: "vip", label: "VIP", when: { v: 1, all: [{ field: "tags", op: "contains", value: "vip" }] } }] } satisfies FlowNodeInput;
      const vipMsg = { id: "mv", type: "message", text: "VIP salom", button: { id: "o", label: "Ochish" } } satisfies FlowNodeInput;
      expect(issuesOf(graph([commentTrigger, cond, vipMsg, opener, end], [["t", "c1"], ["c1", "mv", "branch:vip"], ["c1", "m1", "else"], ["mv", "end", "tap"], ["m1", "end", "tap"]]))).toEqual([]);
    });

    it("DM-side triggers have the window open from the trigger", () => {
      expect(issuesOf(graph([dmTrigger, chips, { id: "d", type: "delay", minutes: 60 }, { id: "m2", type: "message", text: "Eslatma" }, end], [["t", "b1"], ["b1", "d", "tap:a"], ["b1", "end", "other"], ["d", "m2"], ["m2", "end"]]))).toEqual([]);
      const mention = { ...dmTrigger, triggerType: "STORY_MENTION" } satisfies FlowNodeInput;
      expect(issuesOf(graph([mention, chips, end], [["t", "b1"], ["b1", "end", "tap:a"], ["b1", "end", "other"]]))).toEqual([]);
    });
  });

  it("structuralIssues lists the same problems without throwing on a draft", () => {
    const draft = flowGraphDraftSchema.parse(graph([dmTrigger, { id: "m1", type: "message", text: "Salom" }], [["t", "m1"]]));
    expect(structuralIssues(draft).map((i) => i.message)).toContainEqual(expect.stringContaining('«m1» (Xabar) blokining "next" chiqishi bog\'lanmagan'));
  });
});

describe("handle table and node helpers", () => {
  it("HANDLE_RULES and NODE_LABELS cover every node type", () => {
    for (const type of FLOW_NODE_TYPES) {
      expect(HANDLE_RULES[type]).toBeDefined();
      expect(NODE_LABELS[type]).toBeTruthy();
    }
  });

  it("handlesFor adds per-node handles", () => {
    const button: FlowNode = { id: "b", type: "button", text: "?", buttons: [{ id: "x", label: "X", kind: "text" }, { id: "y", label: "Y", kind: "phone", saveAs: "phone" }], onText: "other_edge", timeoutMinutes: 30 };
    expect(handlesFor(button)).toEqual({ required: ["tap:x", "tap:y", "other"], optional: ["timeout"], forbidden: ["next"], terminal: false });
    const cond: FlowNode = { id: "c", type: "condition", branches: [{ id: "a", label: "A", when: { v: 1, all: [] } }] };
    expect(handlesFor(cond).required).toEqual(["branch:a", "else"]);
    const msg: FlowNode = { id: "m", type: "message", text: "x", button: { id: "o", label: "O" }, typingDelayMs: 0 };
    expect(handlesFor(msg)).toEqual({ required: ["tap"], optional: [], forbidden: ["next"], terminal: false });
    expect(handlesFor({ id: "a", type: "ai", mode: "takeover", retries: 1 })).toEqual({ required: [], optional: ["fallback"], forbidden: [], terminal: true });
    expect(handlesFor({ id: "a", type: "ai", mode: "ask", retries: 1 }).required).toEqual(["next", "missing"]);
    expect(handlesFor({ id: "e", type: "end" }).terminal).toBe(true);
  });

  it("isSendNode / isUserWaitNode / templateFields", () => {
    expect(isSendNode({ id: "m", type: "message", text: "x", typingDelayMs: 0 })).toBe(true);
    expect(isSendNode({ id: "a", type: "ai", mode: "takeover", retries: 1 })).toBe(false);
    expect(isSendNode({ id: "a", type: "ai", mode: "takeover", intro: "Salom", retries: 1 })).toBe(true);
    expect(isSendNode({ id: "l", type: "lead", phoneFrom: "vars.phone" })).toBe(false);
    expect(isSendNode({ id: "l", type: "lead", phoneFrom: "vars.phone", thanks: "Rahmat" })).toBe(true);
    expect(isSendNode({ id: "t", type: "tag", action: "add", tagSlugs: ["x"] })).toBe(false);
    expect(isUserWaitNode({ id: "m", type: "message", text: "x", button: { id: "o", label: "O" }, typingDelayMs: 0 })).toBe(true);
    expect(isUserWaitNode({ id: "m", type: "message", text: "x", typingDelayMs: 0 })).toBe(false);
    expect(isUserWaitNode({ id: "d", type: "delay", minutes: 1, ifWindowClosed: "end", cancelOnReply: false })).toBe(false);
    expect(templateFields({ id: "w", type: "webhook", url: "https://a.b/c", method: "POST", body: { phone: "{{vars.phone}}" }, timeoutMs: 5000 })).toEqual([{ field: "body.phone", text: "{{vars.phone}}" }]);
  });
});
