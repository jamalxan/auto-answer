/**
 * Trust ladder (audit 2026-10-26): observe → copilot → auto per intent, the
 * validators, operator-reply pairing, the judge, fact approval, demotion,
 * the golden eval checks and the comment guard's classifier.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const { notify } = vi.hoisted(() => ({ notify: vi.fn(async () => 1) }));
vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/telegram/notify", () => ({ notifyWorkspaceChats: notify, sendWithRetry: vi.fn() }));
vi.mock("@/lib/javobai/knowledge", () => ({
  loadKnowledgeBlock: vi.fn(async () => ({
    profile: { products: [{ price: 100 }], faqs: [], delivery: null, address: "Toshkent", workingHours: null },
    entries: [],
    text: "",
    filterContext: { profileText: "" },
  })),
}));

import { classifyComment } from "@/lib/javobai/comment-guard";
import { checkEvalCase } from "@/lib/javobai/eval";
import { approveFactCandidate } from "@/lib/javobai/facts";
import { judgeOne, saveFactCandidates } from "@/lib/javobai/judge";
import { decideLadder, factCoverage, readiness, LADDER_MIN_SAMPLES } from "@/lib/javobai/ladder";
import { LadderError, demoteIntent, discardDraft, loadIntentMode, pairOperatorReplies, setIntentMode } from "@/lib/javobai/ladder-service";
import { rejectFactCandidate } from "@/lib/javobai/facts";
import { createEvalCase, deleteEvalCase } from "@/lib/javobai/eval";
import { validateReply } from "@/lib/javobai/validate";

const WS = "ws1";
const ACC = "acc1";
const MIN = 60_000;

beforeEach(() => {
  resetDb();
  notify.mockClear();
  db.seed("workspace", { id: WS, name: "W" });
  db.seed("instagramAccount", { id: ACC, workspaceId: WS, instagramId: "ig1", username: "shop" });
  db.seed("assistantProfile", { id: "prof1", workspaceId: WS, instagramAccountId: ACC });
});

describe("decideLadder", () => {
  it("sends everything when the ladder is off, and templates always", () => {
    expect(decideLadder({ ladderEnabled: false, intent: "price_question", mode: null, usedTemplate: false })).toBe("send");
    expect(decideLadder({ ladderEnabled: true, intent: "price_question", mode: null, usedTemplate: true })).toBe("send");
  });
  it("maps modes; no policy row means observe", () => {
    expect(decideLadder({ ladderEnabled: true, intent: "greeting", mode: null, usedTemplate: false })).toBe("observe");
    expect(decideLadder({ ladderEnabled: true, intent: "greeting", mode: "COPILOT", usedTemplate: false })).toBe("draft");
    expect(decideLadder({ ladderEnabled: true, intent: "greeting", mode: "AUTO", usedTemplate: false })).toBe("send");
  });
  it("never auto-answers a complaint even with an AUTO row", () => {
    expect(decideLadder({ ladderEnabled: true, intent: "complaint", mode: "AUTO", usedTemplate: false })).toBe("draft");
  });
});

describe("readiness", () => {
  const cover = factCoverage({ products: [{ price: 100 }], delivery: null, address: null, workingHours: null, entries: [] });
  const samples = (n: number, match = true, critical: string | null = "none") =>
    Array.from({ length: n }, (_, i) => ({ judgeMatch: match, critical, createdAt: new Date(Date.now() - i * MIN) }));

  it("needs 50 judged, 90% match, no critical, the fact", () => {
    expect(readiness("price_question", samples(LADDER_MIN_SAMPLES), cover).ready).toBe(true);
    expect(readiness("price_question", samples(LADDER_MIN_SAMPLES - 1), cover).ready).toBe(false);
    expect(readiness("delivery_question", samples(LADDER_MIN_SAMPLES), cover).missing.join()).toMatch(/fakt/);
    const mixed = [...samples(45), ...samples(10, false)];
    expect(readiness("greeting", mixed, cover).ready).toBe(false);
    const critical = [...samples(60), { judgeMatch: true, critical: "wrong_price", createdAt: new Date() }];
    expect(readiness("greeting", critical, cover).criticalRecent).toBe(1);
  });
});

describe("validateReply", () => {
  const kb = "Divan Milan — 4 500 000 so'm. Yetkazib berish 2 kunda. Chegirma 10%.";
  it("passes numbers from the knowledge", () => {
    expect(validateReply({ reply: "Milan 4.500.000 so'm, 2 kunda yetkazamiz, 10% chegirma bor", knowledge: kb })).toEqual([]);
  });
  it("flags unknown numbers, percents, terms, promises and leaks", () => {
    expect(validateReply({ reply: "Narxi 3 900 000", knowledge: kb })).toContain("unknown_number");
    expect(validateReply({ reply: "Sizga 25% chegirma", knowledge: kb })).toContain("unknown_percent");
    expect(validateReply({ reply: "3 kunda yetkazamiz", knowledge: kb })).toContain("unknown_number");
    expect(validateReply({ reply: "Yetkazib berish bepul!", knowledge: kb })).toContain("promise");
    expect(validateReply({ reply: '{"intent": "greeting"}', knowledge: kb })).toContain("prompt_leak");
  });
  it("does not treat a count as a claim", () => {
    expect(validateReply({ reply: "2 ta rangi bor", knowledge: kb })).toEqual([]);
  });
});

describe("policies", () => {
  it("refuses AUTO before readiness, allows COPILOT", async () => {
    await expect(setIntentMode(WS, ACC, "greeting", "AUTO", "u")).rejects.toBeInstanceOf(LadderError);
    await setIntentMode(WS, ACC, "greeting", "COPILOT", "u");
    expect(await loadIntentMode(ACC, "greeting")).toBe("COPILOT");
  });

  it("allows AUTO after 50 matching judged samples and demotes it on a critical error", async () => {
    for (let i = 0; i < 50; i++) {
      db.seed("aiShadowTurn", {
        workspaceId: WS, instagramAccountId: ACC, intent: "greeting", customerText: "salom", aiReply: "Salom!", operatorReply: "Assalomu alaykum",
        operatorRepliedAt: new Date(), judgeMatch: true, critical: "none", createdAt: new Date(Date.now() - i * MIN),
      });
    }
    await setIntentMode(WS, ACC, "greeting", "AUTO", "u");
    expect(await loadIntentMode(ACC, "greeting")).toBe("AUTO");
    expect(await demoteIntent(ACC, "greeting", "critical_error", "narx xato")).toBe(true);
    expect(await loadIntentMode(ACC, "greeting")).toBe("COPILOT");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await demoteIntent(ACC, "greeting", "critical_error")).toBe(false);
  });
});

describe("pairOperatorReplies", () => {
  it("takes the operator's next message before the customer writes again", async () => {
    const t0 = new Date(Date.now() - 30 * MIN);
    db.seed("conversation", { id: "c1", workspaceId: WS, instagramAccountId: ACC, igUserId: "u1" });
    db.seed("conversationMessage", { id: "m1", conversationId: "c1", author: "CUSTOMER", text: "narxi?", createdAt: t0 });
    db.seed("conversationMessage", { id: "m2", conversationId: "c1", author: "OPERATOR", text: "4 500 000 so'm", createdAt: new Date(t0.getTime() + 2 * MIN) });
    db.seed("aiShadowTurn", { id: "s1", workspaceId: WS, instagramAccountId: ACC, conversationId: "c1", customerMessageId: "m1", customerText: "narxi?", aiReply: "4 500 000", source: "observe", createdAt: t0 });
    expect(await pairOperatorReplies(new Date())).toBe(1);
    const row = db.rows("aiShadowTurn").find((r) => r.id === "s1")!;
    expect(row.operatorReply).toBe("4 500 000 so'm");
  });

  it("drops a sample nobody answered once the customer wrote again", async () => {
    const t0 = new Date(Date.now() - 30 * MIN);
    db.seed("conversation", { id: "c2", workspaceId: WS, instagramAccountId: ACC, igUserId: "u2" });
    db.seed("conversationMessage", { id: "n1", conversationId: "c2", author: "CUSTOMER", text: "salom", createdAt: t0 });
    db.seed("conversationMessage", { id: "n2", conversationId: "c2", author: "CUSTOMER", text: "??", createdAt: new Date(t0.getTime() + MIN) });
    db.seed("conversationMessage", { id: "n3", conversationId: "c2", author: "OPERATOR", text: "ha", createdAt: new Date(t0.getTime() + 2 * MIN) });
    db.seed("aiShadowTurn", { id: "s2", workspaceId: WS, conversationId: "c2", customerMessageId: "n1", customerText: "salom", aiReply: "Salom", source: "observe", createdAt: t0 });
    expect(await pairOperatorReplies(new Date())).toBe(0);
    const row = db.rows("aiShadowTurn").find((r) => r.id === "s2")!;
    expect(row.judgedAt).toBeTruthy();
    expect(row.operatorRepliedAt).toBeNull();
  });
});

describe("judge and facts", () => {
  it("parses the verdict and keeps only new facts", async () => {
    const provider = {
      model: "m",
      complete: vi.fn(async () => ({
        json: {
          match: false,
          score: 0.2,
          critical: "wrong_price",
          notes: "Narx farq qiladi",
          facts: [
            { kind: "PRICE", title: "Milan narxi", body: "Divan Milan 4 500 000 so'm", validDays: 30 },
            { kind: "NOPE", title: "x", body: "Ish vaqti 9-18" },
          ],
        },
        inputTokens: 1,
        outputTokens: 1,
        model: "m",
        latencyMs: 1,
      })),
      costUsd: () => 0,
    };
    const verdict = await judgeOne(provider as never, { workspaceId: WS, conversationId: null, customerText: "narxi?", aiReply: "3 900 000", operatorReply: "4 500 000" });
    expect(verdict).toMatchObject({ match: false, critical: "wrong_price" });
    expect(verdict!.facts[1].kind).toBe("OTHER");
    expect(await saveFactCandidates(WS, ACC, "s1", "4 500 000", verdict!.facts)).toBe(2);
    expect(await saveFactCandidates(WS, ACC, "s1", "4 500 000", verdict!.facts)).toBe(0);
    const price = db.rows("aiFactCandidate").find((f) => f.kind === "PRICE")!;
    expect(price.validUntil).toBeInstanceOf(Date);
  });

  it("approval writes a verified KB entry with the expiry; twice is refused", async () => {
    db.seed("aiFactCandidate", { id: "f1", workspaceId: WS, profileId: "prof1", kind: "PRICE", title: "Milan", body: "4 500 000", status: "PENDING", source: "observed" });
    const entry = await approveFactCandidate(WS, "f1", "u", { validUntil: "2099-01-01T00:00:00Z" });
    expect(entry).toMatchObject({ profileId: "prof1", kind: "PRICE", source: "observed" });
    expect(entry.verifiedAt).toBeInstanceOf(Date);
    expect(entry.expiresAt?.getUTCFullYear()).toBe(2099);
    await expect(approveFactCandidate(WS, "f1", "u")).rejects.toBeInstanceOf(LadderError);
  });
});

describe("golden eval checks", () => {
  it("reports every reason", () => {
    const reasons = checkEvalCase(
      { expectedIntent: "price_question", mustContain: ["4 500 000"], mustNotContain: ["bepul"] },
      { reply: "Yetkazish bepul", intent: "delivery_question", knowledge: "" }
    );
    expect(reasons.join(" | ")).toMatch(/Intent/);
    expect(reasons.join(" | ")).toMatch(/4 500 000/);
    expect(reasons.join(" | ")).toMatch(/bepul/);
    expect(checkEvalCase({ expectedIntent: null, mustContain: [], mustNotContain: [] }, { reply: "Salom!", intent: "greeting", knowledge: "" })).toEqual([]);
  });
});

describe("comment guard classifier", () => {
  it("tells offensive, complaint and normal comments apart", () => {
    expect(classifyComment("Сука, обманщики").verdict).toBe("offensive");
    expect(classifyComment("Pulimni qaytaringlar, aldadinglar").verdict).toBe("complaint");
    expect(classifyComment("Заказ не пришёл уже неделю").verdict).toBe("complaint");
    expect(classifyComment("Narxi qancha? 😍").verdict).toBe("ok");
    expect(classifyComment("Сукачёв").verdict).toBe("ok"); // short words match whole only
  });
});

describe("tenant isolation (IDOR)", () => {
  it("another workspace cannot touch drafts, facts, policies or eval cases", async () => {
    db.seed("workspace", { id: "ws2", name: "Other" });
    db.seed("aiDraft", { id: "d1", workspaceId: WS, instagramAccountId: ACC, conversationId: "c1", text: "x", status: "PENDING" });
    db.seed("aiFactCandidate", { id: "f9", workspaceId: WS, profileId: "prof1", kind: "OTHER", title: "t", body: "b", status: "PENDING" });
    expect(await discardDraft("ws2", "d1", "u")).toBe(false);
    expect(await rejectFactCandidate("ws2", "f9", "u")).toBe(false);
    await expect(approveFactCandidate("ws2", "f9", "u")).rejects.toMatchObject({ status: 404 });
    await expect(setIntentMode("ws2", ACC, "greeting", "COPILOT", "u")).rejects.toMatchObject({ status: 404 });
    await expect(createEvalCase("ws2", ACC, { question: "q" })).rejects.toMatchObject({ status: 404 });
    const own = await createEvalCase(WS, ACC, { question: "q" });
    expect(await deleteEvalCase("ws2", own.id)).toBe(false);
    expect(db.rows("aiDraft")[0].status).toBe("PENDING");
  });
});
