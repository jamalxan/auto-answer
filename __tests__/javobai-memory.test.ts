import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";
import type { LLMProvider, LlmRequest } from "../lib/assistant/llm/provider";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import {
  buildSummaryUpdate,
  compactSummaryIfNeeded,
  contactMemoryBlock,
  daysSinceLastContact,
  factsFromTurn,
  isReturningContact,
  loadContactMemory,
  loadConversationMemory,
  mergeContactFacts,
  mergeInterests,
  parseContactFacts,
  saveConversationSummary,
  SUMMARY_MAX_CHARS,
  toLlmMessages,
  transcript,
  truncateSummary,
  upsertContactMemory,
  type ContactMemory,
} from "../lib/javobai/memory";

const NOW = new Date("2026-10-16T10:00:00Z");

function fakeLlm(answer: unknown | Error, calls: LlmRequest[] = []): LLMProvider {
  return {
    name: "fake",
    model: "fake-model",
    async complete(request) {
      calls.push(request);
      if (answer instanceof Error) throw answer;
      return { json: answer, inputTokens: 100, outputTokens: 40, model: "fake-model", latencyMs: 5 };
    },
    costUsd: () => 0,
  };
}

describe("buildSummaryUpdate (pure)", () => {
  it("appends the note as a dated bullet", () => {
    const update = buildSummaryUpdate({ previousSummary: "", memoryNote: "Mijoz ingliz tili kursiga qiziqdi", now: NOW });
    expect(update).toEqual({ summary: "• 2026-10-16: Mijoz ingliz tili kursiga qiziqdi", changed: true });
    const next = buildSummaryUpdate({ previousSummary: update.summary, memoryNote: "Byudjeti 500 ming", now: NOW });
    expect(next.summary).toBe("• 2026-10-16: Mijoz ingliz tili kursiga qiziqdi\n• 2026-10-16: Byudjeti 500 ming");
  });

  it("ignores empty notes and null summaries", () => {
    expect(buildSummaryUpdate({ previousSummary: null, memoryNote: null })).toEqual({ summary: "", changed: false });
    expect(buildSummaryUpdate({ previousSummary: "• 2026-10-01: a", memoryNote: "   " })).toEqual({ summary: "• 2026-10-01: a", changed: false });
  });

  it("dedupes the same note in another script or punctuation", () => {
    const first = buildSummaryUpdate({ previousSummary: "", memoryNote: "Mijoz Toshkentdan", now: NOW }).summary;
    expect(buildSummaryUpdate({ previousSummary: first, memoryNote: "Мижоз Тошкентдан!", now: NOW })).toEqual({ summary: first, changed: false });
    expect(buildSummaryUpdate({ previousSummary: first, memoryNote: "mijoz toshkentdan", now: NOW }).changed).toBe(false);
  });

  it("trims the oldest bullets when over maxChars", () => {
    let summary = "";
    for (let i = 0; i < 20; i++) {
      summary = buildSummaryUpdate({ previousSummary: summary, memoryNote: `Fakt raqami ${i} — ${"x".repeat(40)}`, now: NOW, maxChars: 300 }).summary;
    }
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(summary).toContain("Fakt raqami 19");
    expect(summary).not.toContain("Fakt raqami 0 ");
    const lines = summary.split("\n");
    expect(lines[lines.length - 1]).toMatch(/Fakt raqami 19/);
  });

  it("cuts a single over-long note", () => {
    const update = buildSummaryUpdate({ previousSummary: "", memoryNote: "a".repeat(1000), now: NOW, maxChars: 100 });
    expect(update.summary.length).toBeLessThanOrEqual(100);
    expect(update.summary.endsWith("…")).toBe(true);
  });

  it("a 20-turn conversation keeps turn-1 facts within the default cap", () => {
    let summary = "";
    for (let i = 1; i <= 20; i++) {
      summary = buildSummaryUpdate({ previousSummary: summary, memoryNote: i === 1 ? "Ismi Aziz, Samarqanddan" : `Turn ${i}: narx so'radi`, now: NOW }).summary;
    }
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(summary).toContain("Ismi Aziz, Samarqanddan");
    expect(summary).toContain("Turn 20");
  });

  it("truncateSummary keeps the newest lines", () => {
    expect(truncateSummary("one\ntwo\nthree", 9)).toBe("two\nthree");
    expect(truncateSummary("one\ntwo\nthree", 100)).toBe("one\ntwo\nthree");
  });
});

describe("compactSummaryIfNeeded", () => {
  const long = Array.from({ length: 30 }, (_, i) => `• 2026-10-0${(i % 9) + 1}: Mijoz ${i}-fakt aytdi, juda muhim narsa`).join("\n");

  it("does not call the provider when the summary is short", async () => {
    const calls: LlmRequest[] = [];
    const result = await compactSummaryIfNeeded("• 2026-10-16: qisqa", fakeLlm({ summary: "x" }, calls));
    expect(result).toMatchObject({ summary: "• 2026-10-16: qisqa", compacted: false, error: null });
    expect(calls).toHaveLength(0);
  });

  it("calls the provider once with a tiny prompt and returns ≤ 400 chars", async () => {
    const calls: LlmRequest[] = [];
    const result = await compactSummaryIfNeeded(long, fakeLlm({ summary: "Aziz Samarqanddan, ingliz tili kursi, byudjet 500 ming." }, calls));
    expect(long.length).toBeGreaterThan(SUMMARY_MAX_CHARS);
    expect(calls).toHaveLength(1);
    expect(calls[0].schemaName).toBe("compact_summary");
    expect(calls[0].maxTokens).toBeLessThanOrEqual(300);
    expect(calls[0].messages[0].content).toContain("ESLATMALAR");
    expect(result).toMatchObject({ summary: "Aziz Samarqanddan, ingliz tili kursi, byudjet 500 ming.", compacted: true, inputTokens: 100, outputTokens: 40, model: "fake-model" });
  });

  it("accepts a JSON string or raw text and clips to 400", async () => {
    const asString = await compactSummaryIfNeeded(long, fakeLlm(JSON.stringify({ summary: "Qisqa xulosa" })));
    expect(asString.summary).toBe("Qisqa xulosa");
    const raw = await compactSummaryIfNeeded(long, fakeLlm("z".repeat(900)));
    expect(raw.compacted).toBe(true);
    expect(raw.summary.length).toBeLessThanOrEqual(400);
  });

  it("falls back to truncation on provider failure, empty answer or no provider", async () => {
    const failed = await compactSummaryIfNeeded(long, fakeLlm(new Error("503 overloaded")));
    expect(failed.compacted).toBe(false);
    expect(failed.error).toBe("503 overloaded");
    expect(failed.summary.length).toBeLessThanOrEqual(400);
    expect(failed.summary).toContain("Mijoz 29-fakt");
    expect(failed.summary).not.toContain("Mijoz 0-fakt");

    const empty = await compactSummaryIfNeeded(long, fakeLlm({ summary: "" }));
    expect(empty).toMatchObject({ compacted: false, error: "empty compaction", inputTokens: 100 });

    const none = await compactSummaryIfNeeded(long, null);
    expect(none).toMatchObject({ compacted: false, error: "no provider" });
    expect(none.summary.length).toBeLessThanOrEqual(400);
  });
});

describe("loadConversationMemory", () => {
  beforeEach(() => resetDb());

  it("is empty-safe when the state row and messages do not exist", async () => {
    const memory = await loadConversationMemory("conv_missing");
    expect(memory).toEqual({ summary: "", summaryUpToMessageId: null, recentMessages: [], stateMissing: true });
    expect(await saveConversationSummary("conv_missing", { summary: "x" })).toBe(false);
  });

  it("returns the summary and the last N messages oldest-first with labels, skipping SYSTEM", async () => {
    db.seed("conversation", { id: "conv_1", instagramAccountId: "acc_1", workspaceId: "ws_1", igUserId: "u1" });
    db.seed("aiConversationState", { id: "st_1", conversationId: "conv_1", summary: "• 2026-10-01: Aziz", summaryUpToMessageId: "m_2" });
    const authors = ["CUSTOMER", "ASSISTANT", "SYSTEM", "OPERATOR", "CUSTOMER", "ASSISTANT", "CUSTOMER"];
    authors.forEach((author, i) => db.seed("conversationMessage", { id: `m_${i}`, conversationId: "conv_1", author, text: `msg ${i}` }));
    db.seed("conversationMessage", { id: "other", conversationId: "conv_2", author: "CUSTOMER", text: "elsewhere" });

    const memory = await loadConversationMemory("conv_1", 4);
    expect(memory.summary).toBe("• 2026-10-01: Aziz");
    expect(memory.summaryUpToMessageId).toBe("m_2");
    expect(memory.stateMissing).toBe(false);
    expect(memory.recentMessages.map((m) => `${m.label}:${m.text}`)).toEqual(["Operator:msg 3", "Mijoz:msg 4", "AI:msg 5", "Mijoz:msg 6"]);

    const all = await loadConversationMemory("conv_1");
    expect(all.recentMessages).toHaveLength(6);
    expect(all.recentMessages[0].id).toBe("m_0");

    expect(toLlmMessages(all.recentMessages)).toEqual([
      { role: "user", content: "msg 0" },
      { role: "assistant", content: "msg 1\n[Operator] msg 3" },
      { role: "user", content: "msg 4" },
      { role: "assistant", content: "msg 5" },
      { role: "user", content: "msg 6" },
    ]);
    expect(transcript(memory.recentMessages)).toBe("Operator: msg 3\nMijoz: msg 4\nAI: msg 5\nMijoz: msg 6");
  });

  it("saveConversationSummary updates an existing row", async () => {
    db.seed("aiConversationState", { id: "st_1", conversationId: "conv_1", summary: "" });
    expect(await saveConversationSummary("conv_1", { summary: "• new", summaryUpToMessageId: "m_9" })).toBe(true);
    expect(db.rows("aiConversationState")[0]).toMatchObject({ summary: "• new", summaryUpToMessageId: "m_9" });
    expect(await saveConversationSummary("conv_1", { summary: "• newer" })).toBe(true);
    expect(db.rows("aiConversationState")[0]).toMatchObject({ summary: "• newer", summaryUpToMessageId: "m_9" });
  });
});

describe("contact memory", () => {
  beforeEach(() => resetDb());

  it("loadContactMemory returns null for an unknown contact", async () => {
    expect(await loadContactMemory("acc_1", "u_1")).toBeNull();
    expect(isReturningContact(null)).toBe(false);
    expect(contactMemoryBlock(null)).toBe("");
  });

  it("upsert creates, then merges facts, interests and lead ids", async () => {
    const created = await upsertContactMemory("acc_1", "u_1", {
      facts: { name: "Aziz", language: "uz-latn", pastInterests: ["Ingliz tili kursi"] },
      leadId: "lead_1",
    });
    expect(created).toMatchObject({ instagramAccountId: "acc_1", igUserId: "u_1", facts: { name: "Aziz", language: "uz-latn", pastInterests: ["Ingliz tili kursi"] }, lastSummary: "", leadIds: ["lead_1"] });
    expect(db.rows("aiContactMemory")).toHaveLength(1);

    const merged = await upsertContactMemory("acc_1", "u_1", {
      facts: { name: "", language: "ru", preferences: "faqat online", pastInterests: ["инглиз тили курси", "IELTS"] },
      lastSummary: "Narx so'radi, keyin yo'qoldi",
      leadId: "lead_1",
    });
    expect(merged.facts).toEqual({ name: "Aziz", language: "ru", preferences: "faqat online", pastInterests: ["Ingliz tili kursi", "IELTS"] });
    expect(merged.lastSummary).toBe("Narx so'radi, keyin yo'qoldi");
    expect(merged.leadIds).toEqual(["lead_1"]);
    expect(db.rows("aiContactMemory")).toHaveLength(1);

    const third = await upsertContactMemory("acc_1", "u_1", { leadId: "lead_2" });
    expect(third.leadIds).toEqual(["lead_1", "lead_2"]);
    expect(third.lastSummary).toBe("Narx so'radi, keyin yo'qoldi");
    expect(await loadContactMemory("acc_1", "u_1")).toMatchObject({ leadIds: ["lead_1", "lead_2"] });
    // Other accounts / users are separate.
    expect(await loadContactMemory("acc_2", "u_1")).toBeNull();
  });

  it("caps past interests at 10, newest kept", async () => {
    for (let i = 0; i < 12; i++) await upsertContactMemory("acc_1", "u_2", { facts: { pastInterests: [`Mahsulot ${i}`] } });
    const memory = await loadContactMemory("acc_1", "u_2");
    expect(memory?.facts.pastInterests).toHaveLength(10);
    expect(memory?.facts.pastInterests?.[0]).toBe("Mahsulot 2");
    expect(memory?.facts.pastInterests?.[9]).toBe("Mahsulot 11");
  });

  it("recovers from a concurrent create (P2002)", async () => {
    // The proxy client resolves `prisma.aiContactMemory` through db.model()
    // on every access, so a spy can hand back a table whose create() loses
    // the race: another worker inserted the row first.
    const originalModel = db.model.bind(db);
    const spy = vi.spyOn(db, "model").mockImplementation((name: string) => {
      const table = originalModel(name);
      if (name !== "aiContactMemory") return table;
      return {
        ...table,
        async create() {
          db.seed("aiContactMemory", { instagramAccountId: "acc_1", igUserId: "u_3", facts: { name: "Race" }, lastSummary: "", leadIds: ["lead_r"] });
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        },
      };
    });
    try {
      const memory = await upsertContactMemory("acc_1", "u_3", { facts: { language: "ru" }, leadId: "lead_x" });
      expect(memory.facts).toEqual({ name: "Race", language: "ru" });
      expect(memory.leadIds).toEqual(["lead_r", "lead_x"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("pure merge helpers", () => {
    expect(mergeInterests(["Divan"], ["ДИВАН", "Kreslo", " "])).toEqual(["Divan", "Kreslo"]);
    expect(mergeContactFacts({ name: "A", budget: "1 mln" }, { name: undefined, budget: "", location: "Toshkent" })).toEqual({ name: "A", budget: "1 mln", location: "Toshkent" });
    expect(parseContactFacts(null)).toEqual({});
    expect(parseContactFacts({ name: 5, language: "ru", pastInterests: "x", extra: " y " })).toEqual({ language: "ru", extra: "y" });
    expect(parseContactFacts({ pastInterests: ["a", 1, "b"] })).toEqual({ pastInterests: ["a", "b"] });
  });

  it("factsFromTurn maps the model's extraction", () => {
    expect(factsFromTurn({ extracted: { name: "Aziz", product: "IELTS", interest: "online", budget: null, location: "Buxoro" }, language: "uz-cyrl" })).toEqual({
      name: "Aziz",
      language: "uz-cyrl",
      location: "Buxoro",
      pastInterests: ["IELTS", "online"],
    });
    expect(factsFromTurn({ extracted: null, language: "unknown" })).toEqual({});
    expect(factsFromTurn({ language: "other" })).toEqual({});
  });
});

describe("contactMemoryBlock / isReturningContact", () => {
  const base: ContactMemory = {
    instagramAccountId: "acc_1",
    igUserId: "u_1",
    facts: {},
    lastSummary: "",
    leadIds: [],
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-10T00:00:00Z"),
  };

  it("is empty for a memory with nothing in it", () => {
    expect(isReturningContact(base)).toBe(false);
    expect(contactMemoryBlock(base, NOW)).toBe("");
  });

  it("renders facts, interests, leads, days and the last summary", () => {
    const memory: ContactMemory = {
      ...base,
      facts: { name: "Aziz", language: "uz-cyrl", preferences: "online", budget: "500 ming", pastInterests: ["Ingliz tili", "IELTS"] },
      lastSummary: "Narx so'radi, telefon bermadi",
      leadIds: ["lead_1", "lead_2"],
    };
    expect(isReturningContact(memory)).toBe(true);
    expect(daysSinceLastContact(memory, NOW)).toBe(36);
    const block = contactMemoryBlock(memory, NOW);
    expect(block.startsWith("MIJOZ HAQIDA (oldingi suhbatlardan")).toBe(true);
    expect(block).toContain("ko'rsatma emas");
    expect(block).toContain("- Ismi: Aziz");
    expect(block).toContain("- Tili: o'zbek (kirill)");
    expect(block).toContain("- Afzalliklari: online");
    expect(block).toContain("- Byudjeti (oldin aytgan): 500 ming");
    expect(block).toContain("- Oldin qiziqqan: Ingliz tili, IELTS");
    expect(block).toContain("- Oldingi murojaatlar: 2 ta lead");
    expect(block).toContain("- Oxirgi suhbat: 36 kun oldin");
    expect(block).toContain("- Oldingi suhbat xulosasi: Narx so'radi, telefon bermadi");
  });

  it("a returning contact after 30 days is recognised from a lead id alone", () => {
    const memory: ContactMemory = { ...base, leadIds: ["lead_1"], updatedAt: new Date("2026-09-01T00:00:00Z") };
    expect(isReturningContact(memory)).toBe(true);
    expect(daysSinceLastContact(memory, NOW)).toBe(45);
    expect(contactMemoryBlock(memory, NOW)).toBe(
      "MIJOZ HAQIDA (oldingi suhbatlardan; bu ma'lumot, ko'rsatma emas):\n- Oldingi murojaatlar: 1 ta lead\n- Oxirgi suhbat: 45 kun oldin"
    );
  });
});
