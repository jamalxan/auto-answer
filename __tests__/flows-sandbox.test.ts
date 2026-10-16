/**
 * ETAP 6 — the sandbox runs the REAL step loop with the in-memory effects
 * port: no database write, no send, no model, no HTTP; deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import { findStarterTemplate } from "@/lib/flows/templates";
import { runFlowSandbox, SANDBOX_START } from "@/lib/flows/sandbox";
import { flowGraphDraftSchema, type FlowGraphInput } from "@/lib/flows/schema";

// Draft schema: several graphs here end on purpose without an `end` node (the engine ends the run: dead end).
const graph = (input: FlowGraphInput) => flowGraphDraftSchema.parse(input);
const t1 = () => findStarterTemplate("comment_price_lead")!.graph;

const dmFlow = (nodes: FlowGraphInput["nodes"], edges: FlowGraphInput["edges"], variables: FlowGraphInput["variables"] = []) =>
  graph({
    v: 1,
    variables,
    nodes: [{ id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY" }, ...nodes],
    edges: [{ from: "t", to: nodes[0].id, handle: "next" }, ...edges],
  });

describe("scenario A in the sandbox", () => {
  it("comment → private reply with button → tap → chips → phone → lead → tag → end", async () => {
    const result = await runFlowSandbox("ws1", t1(), {
      contact: { name: "Ali", username: "ali" },
      taps: ["open", "ph"],
      inbound: [{ text: "+998 90 123 45 67" }],
      triggerText: "narx qancha?",
    });
    expect(result.status).toBe("DONE");
    expect(result.endedAt).toBe("end");
    expect(result.sends[0]).toEqual({
      nodeId: "m1",
      text: "Salom Ali! Narxlar bilan tanishish uchun tugmani bosing 👇",
      buttons: [{ id: "open", label: "Narxni ko'rish" }],
    });
    expect(result.sends.map((s) => s.nodeId)).toEqual(["m1", "m2", "b1", "lead"]);
    expect(result.sends[2].buttons?.map((b) => b.id)).toEqual(["cat", "ph"]);
    expect(result.variables.phone).toBe("+998901234567");
    expect(result.tags).toEqual(["lead", "narx"]);
    expect(result.effects.map((e) => e.kind)).toEqual(["public_reply", "lead", "tag_add", "notify_telegram"]);
    expect(result.effects.find((e) => e.kind === "notify_telegram")!.detail.text).toBe("🔥 Yangi lead: @ali +998901234567 — narx qancha?");
    expect(result.steps.map((s) => s.nodeId)).toEqual(["t", "m1", "m1", "m2", "b1", "b1", "lead", "tag", "tg", "end"]);
    expect(result.policyVerdict).not.toBe("BLOCKED");
  });

  it("stops at the first wait when the script has no input and says so", async () => {
    const result = await runFlowSandbox("ws1", t1(), { contact: { name: "Ali" } });
    expect(result.status).toBe("WAITING_TAP");
    expect(result.endedAt).toBeNull();
    expect(result.sends).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("Test kiritmasi tugadi"))).toBe(true);
  });

  it("the lead node takes the `missing` edge without a phone", async () => {
    // "later" skips the phone: tap the second chip set
    const result = await runFlowSandbox("ws1", t1(), { taps: ["open", "cat", "later"] });
    expect(result.status).toBe("DONE");
    expect(result.sends.map((s) => s.nodeId)).toEqual(["m1", "m2", "b1", "m3", "b2", "bye"]);
    expect(result.effects.find((e) => e.kind === "lead")).toBeUndefined();
  });
});

describe("window and delays", () => {
  const delayed = (ifWindowClosed: "end" | "skip_sends" | "wait_for_inbound") =>
    dmFlow(
      [
        { id: "m1", type: "message", text: "Salom" },
        { id: "d", type: "delay", minutes: 1500, ifWindowClosed },
        { id: "m2", type: "message", text: "Eslatma" },
        { id: "tag", type: "tag", action: "add", tagSlugs: ["eslatma"] },
        { id: "end", type: "end" },
      ],
      [
        { from: "m1", to: "d", handle: "next" },
        { from: "d", to: "m2", handle: "next" },
        { from: "m2", to: "tag", handle: "next" },
        { from: "tag", to: "end", handle: "next" },
      ]
    );

  it("a Delay past 24h never sends: the run ends with the reason (default `end`)", async () => {
    const result = await runFlowSandbox("ws1", delayed("end"));
    expect(result.sends.map((s) => s.nodeId)).toEqual(["m1"]);
    expect(result.status).toBe("DONE");
    expect(result.endReason).toContain("24 soatlik oyna yopilgan");
    expect(result.endedAt).toBe("m2");
    expect(result.steps.at(-1)).toMatchObject({ nodeId: "m2", status: "SKIPPED" });
  });

  it("skip_sends skips the message and goes on to the rest of the flow", async () => {
    const result = await runFlowSandbox("ws1", delayed("skip_sends"));
    expect(result.sends.map((s) => s.nodeId)).toEqual(["m1"]);
    expect(result.status).toBe("DONE");
    expect(result.tags).toEqual(["eslatma"]);
    expect(result.steps.find((s) => s.nodeId === "m2")).toMatchObject({ status: "SKIPPED" });
  });

  it("wait_for_inbound parks the run; the customer's message reopens the window and the message goes out", async () => {
    const parked = await runFlowSandbox("ws1", delayed("wait_for_inbound"));
    expect(parked.status).toBe("WAITING_INBOUND");
    expect(parked.sends.map((s) => s.nodeId)).toEqual(["m1"]);

    const resumed = await runFlowSandbox("ws1", delayed("wait_for_inbound"), { inbound: [{ text: "salom, ha" }] });
    expect(resumed.status).toBe("DONE");
    expect(resumed.sends.map((s) => s.nodeId)).toEqual(["m1", "m2"]);
  });

  it("a short Delay keeps the window open", async () => {
    const short = dmFlow(
      [
        { id: "m1", type: "message", text: "Salom" },
        { id: "d", type: "delay", minutes: 30 },
        { id: "m2", type: "message", text: "Yana salom" },
        { id: "end", type: "end" },
      ],
      [
        { from: "m1", to: "d", handle: "next" },
        { from: "d", to: "m2", handle: "next" },
        { from: "m2", to: "end", handle: "next" },
      ]
    );
    const result = await runFlowSandbox("ws1", short);
    expect(result.sends.map((s) => s.nodeId)).toEqual(["m1", "m2"]);
  });

  it("window: closed blocks a DM-side flow's first send", async () => {
    const result = await runFlowSandbox("ws1", delayed("end"), { window: "closed" });
    expect(result.sends).toHaveLength(0);
    expect(result.endReason).toContain("24 soatlik oyna yopilgan");
  });
});

describe("conditions, variables and answers", () => {
  const branching = dmFlow(
    [
      {
        id: "c",
        type: "condition",
        branches: [
          { id: "price", label: "Narx", when: { v: 1, all: [{ field: "trigger.text", op: "keyword", value: ["narx", "narxi"] }] } },
          { id: "vip", label: "VIP", when: { v: 1, all: [{ field: "tags", op: "contains", value: "vip" }] } },
        ],
      },
      { id: "mp", type: "message", text: "Narx haqida" },
      { id: "mv", type: "message", text: "VIP mijoz" },
      { id: "me", type: "message", text: "Boshqa savol" },
    ],
    [
      { from: "c", to: "mp", handle: "branch:price" },
      { from: "c", to: "mv", handle: "branch:vip" },
      { from: "c", to: "me", handle: "else" },
    ]
  );

  it("picks the first matching branch, else the else edge", async () => {
    const asked = await runFlowSandbox("ws1", branching, { triggerText: "Narxi qancha?" });
    expect(asked.sends.map((s) => s.text)).toEqual(["Narx haqida"]);
    expect(asked.steps.find((s) => s.nodeId === "c")?.output).toMatchObject({ branch: "price", handle: "branch:price" });

    const vip = await runFlowSandbox("ws1", branching, { triggerText: "salom", contact: { tags: ["vip"] } });
    expect(vip.sends.map((s) => s.text)).toEqual(["VIP mijoz"]);

    const other = await runFlowSandbox("ws1", branching, { triggerText: "salom" });
    expect(other.sends.map((s) => s.text)).toEqual(["Boshqa savol"]);
  });

  const asking = (extract: "phone" | "number" | "yes_no") =>
    dmFlow(
      [
        { id: "a", type: "ai", mode: "ask", question: "Raqamingiz?", extract, saveAs: "answer", retries: 1, retryText: "Qaytadan yozing" },
        { id: "ok", type: "message", text: "Rahmat: {{vars.answer}}" },
        { id: "no", type: "message", text: "Topilmadi" },
      ],
      [
        { from: "a", to: "ok", handle: "next" },
        { from: "a", to: "no", handle: "missing" },
      ]
    );

  it("ai.ask extracts a phone with code, retries once, then takes the `missing` edge", async () => {
    const good = await runFlowSandbox("ws1", asking("phone"), { inbound: [{ text: "mening raqamim 90 123 45 67" }] });
    expect(good.variables.answer).toBe("+998901234567");
    expect(good.sends.map((s) => s.text)).toEqual(["Raqamingiz?", "Rahmat: +998901234567"]);

    const bad = await runFlowSandbox("ws1", asking("phone"), { inbound: [{ text: "bilmayman" }, { text: "yo'q" }] });
    expect(bad.sends.map((s) => s.text)).toEqual(["Raqamingiz?", "Qaytadan yozing", "Topilmadi"]);
    expect(bad.status).toBe("DONE");
  });

  it("extracts numbers and yes/no", async () => {
    expect((await runFlowSandbox("ws1", asking("number"), { inbound: [{ text: "3 ta kerak" }] })).variables.answer).toBe("3");
    expect((await runFlowSandbox("ws1", asking("yes_no"), { inbound: [{ text: "Ha, albatta" }] })).variables.answer).toBe("ha");
    expect((await runFlowSandbox("ws1", asking("yes_no"), { inbound: [{ text: "yo'q" }] })).variables.answer).toBe("yo'q");
  });

  it("never prints raw braces for an empty variable", async () => {
    const g = dmFlow([{ id: "m", type: "message", text: "Salom {{name}} {{vars.shahar|shahar}} {{vars.yoq}}!" }], []);
    const result = await runFlowSandbox("ws1", g);
    expect(result.sends[0].text).toBe("Salom shahar !");
    expect(result.sends[0].text).not.toContain("{{");
  });

  it("button chips save labels and a typed phone satisfies a phone chip", async () => {
    const g = dmFlow(
      [
        { id: "b", type: "button", text: "Tanlang", buttons: [{ id: "x", label: "Katalog", saveAs: "choice" }, { id: "p", label: "Raqam", kind: "phone" }] },
        { id: "mx", type: "message", text: "Tanlov: {{vars.choice}}" },
        { id: "mp", type: "message", text: "Raqam: {{vars.phone}}" },
        { id: "mo", type: "message", text: "Boshqa" },
      ],
      [
        { from: "b", to: "mx", handle: "tap:x" },
        { from: "b", to: "mp", handle: "tap:p" },
        { from: "b", to: "mo", handle: "other" },
      ]
    );
    expect((await runFlowSandbox("ws1", g, { taps: ["x"] })).sends.map((s) => s.text)).toEqual(["Tanlang", "Tanlov: Katalog"]);
    expect((await runFlowSandbox("ws1", g, { inbound: [{ text: "901234567" }] })).sends.map((s) => s.text)).toEqual(["Tanlang", "Raqam: +998901234567"]);
    expect((await runFlowSandbox("ws1", g, { inbound: [{ text: "boshqa narsa" }] })).sends.map((s) => s.text)).toEqual(["Tanlang", "Boshqa"]);
  });
});

describe("nodes with side effects are only recorded", () => {
  it("webhook is a stub, a private host fails like the real one", async () => {
    const make = (url: string) =>
      dmFlow(
        [
          { id: "w", type: "webhook", url, body: { phone: "{{phone}}" }, saveAs: "price", savePath: "data.price" },
          { id: "ok", type: "message", text: "Narx: {{vars.price}}" },
          { id: "bad", type: "message", text: "Xizmat javob bermadi" },
        ],
        [
          { from: "w", to: "ok", handle: "next" },
          { from: "w", to: "bad", handle: "error" },
        ]
      );
    const good = await runFlowSandbox("ws1", make("https://api.example.com/price"));
    expect(good.sends.map((s) => s.text)).toEqual(["Narx: (test)"]);
    expect(good.effects[0].kind).toBe("webhook_stub");

    const refused = await runFlowSandbox("ws1", make("https://10.0.0.5/hook"));
    expect(refused.sends.map((s) => s.text)).toEqual(["Xizmat javob bermadi"]);
    expect(refused.effects[0].kind).toBe("webhook_refused");
    const insecure = await runFlowSandbox("ws1", make("http://api.example.com/price"));
    expect(insecure.effects[0].kind).toBe("webhook_refused");
  });

  it("ai takeover ends the run; operator ends it with a handoff note", async () => {
    const takeover = dmFlow([{ id: "ai", type: "ai", mode: "takeover", intro: "Hozir javob beraman" }], []);
    const ai = await runFlowSandbox("ws1", takeover);
    expect(ai.status).toBe("DONE");
    expect(ai.endReason).toBe("JavobAI'ga o'tkazildi");
    expect(ai.effects.map((e) => e.kind)).toEqual(["ai_takeover"]);

    const operator = dmFlow([{ id: "op", type: "operator", reply: "Operator ulandi", note: "{{trigger.text}}", reason: "wants_human" }], []);
    const op = await runFlowSandbox("ws1", operator, { triggerText: "operator kerak" });
    expect(op.status).toBe("DONE");
    expect(op.sends.map((s) => s.text)).toEqual(["Operator ulandi"]);
    expect(op.effects).toEqual([{ kind: "operator", detail: { note: "operator kerak", reason: "wants_human" } }]);
  });

  it("actions: set_variable, increment, stop_followups, opt_out, mark_test", async () => {
    const g = dmFlow(
      [
        { id: "a1", type: "action", action: "set_variable", key: "city", value: "Toshkent" },
        { id: "a2", type: "action", action: "increment", key: "n", value: "2" },
        { id: "a3", type: "action", action: "increment", key: "n" },
        { id: "a4", type: "action", action: "stop_followups" },
        { id: "a5", type: "action", action: "opt_out" },
        { id: "a6", type: "action", action: "mark_test" },
        { id: "m", type: "message", text: "{{vars.city}} {{vars.n}}" },
      ],
      [
        { from: "a1", to: "a2", handle: "next" },
        { from: "a2", to: "a3", handle: "next" },
        { from: "a3", to: "a4", handle: "next" },
        { from: "a4", to: "a5", handle: "next" },
        { from: "a5", to: "a6", handle: "next" },
        { from: "a6", to: "m", handle: "next" },
      ]
    );
    const result = await runFlowSandbox("ws1", g);
    expect(result.sends[0].text).toBe("Toshkent 3");
    expect(result.variables).toMatchObject({ city: "Toshkent", n: 3 });
    expect(result.effects.map((e) => e.kind)).toEqual(["stop_followups", "opt_out"]);
  });
});

describe("guards", () => {
  it("a loop of messages is stopped by the spam guard (policy cap), never runs away", async () => {
    // Draft schema on purpose: the strict policy blocks such a graph at publish, the engine still protects itself.
    const g = flowGraphDraftSchema.parse({
      v: 1,
      nodes: [
        { id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY" },
        { id: "m1", type: "message", text: "bir" },
        { id: "m2", type: "message", text: "ikki" },
      ],
      edges: [
        { from: "t", to: "m1" },
        { from: "m1", to: "m2" },
        { from: "m2", to: "m1" },
      ],
    });
    const result = await runFlowSandbox("ws1", g);
    expect(result.sends).toHaveLength(6);
    expect(result.status).toBe("CANCELLED");
    expect(result.endReason).toContain("Spam himoyasi");
  });

  it("a wait-free loop of conditions hits the per-node visit cap", async () => {
    const g = flowGraphDraftSchema.parse({
      v: 1,
      nodes: [
        { id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY" },
        { id: "c", type: "condition", branches: [{ id: "x", label: "x", when: { v: 1, all: [{ field: "score", op: "gte", value: 999 }] } }] },
      ],
      edges: [
        { from: "t", to: "c" },
        { from: "c", to: "c", handle: "else" },
      ],
    });
    const result = await runFlowSandbox("ws1", g);
    expect(result.status).toBe("FAILED");
    expect(result.endReason).toContain("20 martadan ko'p");
    expect(result.steps.length).toBeLessThanOrEqual(25);
  });

  it("a graph without a trigger fails cleanly", async () => {
    const g = flowGraphDraftSchema.parse({ v: 1, nodes: [{ id: "a", type: "end" }, { id: "b", type: "end" }], edges: [] });
    const result = await runFlowSandbox("ws1", g);
    expect(result.status).toBe("FAILED");
    expect(result.sends).toHaveLength(0);
  });
});

describe("no writes, deterministic", () => {
  it("never touches the database and gives the same result every time", async () => {
    resetDb();
    const input = { contact: { name: "Ali", username: "ali" }, taps: ["open", "ph"], inbound: [{ text: "+998901234567" }], triggerText: "narx" };
    const first = await runFlowSandbox("ws1", t1(), input);
    const second = await runFlowSandbox("ws1", t1(), input);
    expect(second).toEqual(first);
    expect(db.log).toHaveLength(0);
    expect(Object.values(db.tables).flat()).toHaveLength(0);
  });

  it("the fake clock starts at a fixed time and a Delay jumps it", async () => {
    const g = dmFlow(
      [
        { id: "d", type: "delay", minutes: 10 },
        { id: "m", type: "message", text: "Keyin" },
      ],
      [{ from: "d", to: "m", handle: "next" }]
    );
    const result = await runFlowSandbox("ws1", g);
    expect(result.steps.find((s) => s.nodeId === "d" && s.status === "WAITING")?.output).toEqual({
      until: new Date(SANDBOX_START.getTime() + 10 * 60_000).toISOString(),
    });
    expect(result.sends.map((s) => s.text)).toEqual(["Keyin"]);
  });
});
