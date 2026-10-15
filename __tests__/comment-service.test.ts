/**
 * Comment Automation 2.0 service: input validation (zod rules with Uzbek
 * messages), the replace-all variant save plan, and workspace scoping of the
 * write paths (another workspace's ids look like "not found").
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    triggerCampaign: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    triggerReplyVariant: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    triggerQuickReply: { findMany: vi.fn(), deleteMany: vi.fn() },
    triggerFollowUpStep: { findMany: vi.fn(), deleteMany: vi.fn() },
    triggerFollowUpRun: { updateMany: vi.fn() },
    triggerExecution: { findFirst: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  startBacktrack: vi.fn(),
  expireStaleBacktrackRuns: vi.fn(),
  cancelFollowUps: vi.fn(),
  simulateComment: vi.fn(),
  forgetAccountGate: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/meta/client", () => ({ getUserMedia: vi.fn() }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (v: string) => v }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: mocks.forgetAccountGate }));
vi.mock("@/lib/triggers/backtrack", () => ({
  startBacktrack: mocks.startBacktrack,
  expireStaleBacktrackRuns: mocks.expireStaleBacktrackRuns,
}));
vi.mock("@/lib/triggers/followups", () => ({ cancelFollowUps: mocks.cancelFollowUps }));
vi.mock("@/lib/triggers/comment-handler", () => ({ simulateComment: mocks.simulateComment }));
vi.mock("@/lib/triggers/keywords", () => ({
  BUILT_IN_INTENTS: [
    { key: "PRICE", label: "Narx", examples: ["narx", "цена"] },
    { key: "ADDRESS", label: "Manzil", examples: ["manzil"] },
  ],
  normalizeForMatch: (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim(),
}));

import {
  backtrackInputSchema,
  cancelExecutionFollowUps,
  commentCampaignSchema,
  firstIssue,
  followUpsInputSchema,
  planVariantSave,
  quickRepliesInputSchema,
  saveQuickReplies,
  saveVariants,
  setCommentCampaignActive,
  setVariantApproved,
  startCampaignBacktrack,
  updateCommentCampaign,
  variantsInputSchema,
  type ExistingVariant,
} from "@/lib/triggers/comment-service";

const base = {
  name: "Narx kampaniyasi",
  instagramAccountId: "acc1",
  matchingMode: "CONTAINS",
  keywords: ["narx"],
  responseMessage: "Salom! Narxini Direct'da yubordim.",
};

function issue(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  return firstIssue(result.error as Parameters<typeof firstIssue>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("commentCampaignSchema", () => {
  it("accepts a minimal campaign and fills defaults", () => {
    const parsed = commentCampaignSchema.parse(base);
    expect(parsed).toMatchObject({
      mediaScope: "ANY",
      mediaIds: [],
      intents: [],
      priority: 0,
      replyMode: "RANDOM",
      publicReplyEnabled: false,
      openingButtonLabel: null,
      mainMessage: null,
      stopOnReply: true,
      active: true,
    });
  });

  it("needs a keyword or an intent unless every comment is answered", () => {
    expect(issue(commentCampaignSchema, { ...base, keywords: [] })).toMatch(/kalit so'z yoki intent/);
    expect(commentCampaignSchema.safeParse({ ...base, keywords: [], intents: ["PRICE"] }).success).toBe(true);
    const every = commentCampaignSchema.parse({ ...base, matchingMode: "EVERY", keywords: ["narx"], intents: ["PRICE"] });
    expect(every.keywords).toEqual([]);
    expect(every.intents).toEqual([]);
  });

  it("drops empty and normalised duplicate keywords, keeping the first spelling", () => {
    const parsed = commentCampaignSchema.parse({ ...base, keywords: [" Narx ", "narx!", "", "info"] });
    expect(parsed.keywords).toEqual(["Narx", "info"]);
  });

  it("enforces keyword count and length", () => {
    expect(issue(commentCampaignSchema, { ...base, keywords: ["x".repeat(61)] })).toMatch(/60 belgidan/);
    const many = Array.from({ length: 51 }, (_, i) => `k${i}`);
    expect(issue(commentCampaignSchema, { ...base, keywords: many })).toMatch(/50 ta/);
  });

  it("rejects unknown intents", () => {
    expect(issue(commentCampaignSchema, { ...base, intents: ["HACK"] })).toMatch(/Noma'lum intent: HACK/);
  });

  it("needs a post when the scope is SPECIFIC, and clears ids for ANY", () => {
    expect(issue(commentCampaignSchema, { ...base, mediaScope: "SPECIFIC" })).toMatch(/post tanlang/);
    expect(commentCampaignSchema.parse({ ...base, mediaScope: "ANY", mediaIds: ["1"] }).mediaIds).toEqual([]);
    expect(commentCampaignSchema.parse({ ...base, mediaScope: "SPECIFIC", mediaIds: ["1", "1", "2"] }).mediaIds).toEqual([
      "1",
      "2",
    ]);
  });

  it("bounds priority, button label and messages", () => {
    expect(issue(commentCampaignSchema, { ...base, priority: 101 })).toMatch(/Prioritet/);
    expect(issue(commentCampaignSchema, { ...base, priority: 1.5 })).toMatch(/butun/);
    expect(
      issue(commentCampaignSchema, { ...base, openingButtonLabel: "x".repeat(21), mainMessage: "Salom" })
    ).toMatch(/20 belgidan/);
    expect(issue(commentCampaignSchema, { ...base, responseMessage: "x".repeat(1001) })).toMatch(/1000/);
    expect(issue(commentCampaignSchema, { ...base, responseMessage: "  " })).toMatch(/Zaxira DM/);
  });

  it("pairs the opening button with the main message", () => {
    expect(issue(commentCampaignSchema, { ...base, mainMessage: "Katalog" })).toMatch(/tugma nomini kiriting/);
    expect(issue(commentCampaignSchema, { ...base, openingButtonLabel: "Narx" })).toMatch(/asosiy xabarni/);
    const ok = commentCampaignSchema.parse({ ...base, openingButtonLabel: " Narx ", mainMessage: " Katalog " });
    expect(ok.openingButtonLabel).toBe("Narx");
    expect(ok.mainMessage).toBe("Katalog");
    expect(commentCampaignSchema.parse({ ...base, openingButtonLabel: "  ", mainMessage: "" }).openingButtonLabel).toBeNull();
  });

  it("keeps the fallback DM within Meta's 640-character button template when the button is on", () => {
    const withButton = { ...base, openingButtonLabel: "Narx", mainMessage: "Katalog" };
    expect(issue(commentCampaignSchema, { ...withButton, responseMessage: "x".repeat(641) })).toMatch(/640.*button template/);
    expect(commentCampaignSchema.safeParse({ ...withButton, responseMessage: "x".repeat(640) }).success).toBe(true);
    expect(commentCampaignSchema.safeParse({ ...base, responseMessage: "x".repeat(641) }).success).toBe(true);
  });
});

describe("variantsInputSchema", () => {
  const dm = (text: string) => ({ kind: "DM", text });

  it("caps each kind at 10 and refuses duplicates", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => dm(`Variant ${i}`));
    expect(issue(variantsInputSchema, { variants: eleven })).toMatch(/ko'pi bilan 10/);
    expect(issue(variantsInputSchema, { variants: [dm("Salom"), dm("salom")] })).toMatch(/Bir xil variant/);
    const mixed = [...Array.from({ length: 10 }, (_, i) => dm(`D${i}`)), { kind: "PUBLIC", text: "P" }];
    expect(variantsInputSchema.safeParse({ variants: mixed }).success).toBe(true);
  });

  it("uses a shorter limit for public replies", () => {
    expect(variantsInputSchema.safeParse({ variants: [dm("x".repeat(1000))] }).success).toBe(true);
    expect(issue(variantsInputSchema, { variants: [{ kind: "PUBLIC", text: "x".repeat(301) }] })).toMatch(/300/);
    expect(issue(variantsInputSchema, { variants: [dm("x".repeat(1001))] })).toMatch(/1000/);
  });

  it("checks weights and empty text", () => {
    expect(issue(variantsInputSchema, { variants: [{ ...dm("A"), weight: 0 }] })).toMatch(/Vazn/);
    expect(issue(variantsInputSchema, { variants: [{ ...dm("A"), weight: 101 }] })).toMatch(/Vazn/);
    expect(issue(variantsInputSchema, { variants: [dm("   ")] })).toMatch(/Bo'sh/);
  });
});

describe("planVariantSave", () => {
  const now = new Date("2026-10-15T10:00:00Z");
  const earlier = new Date("2026-10-01T10:00:00Z");
  const existing: ExistingVariant[] = [
    { id: "m1", kind: "DM", text: "Manual", source: "MANUAL", approvedAt: earlier },
    { id: "a1", kind: "DM", text: "AI approved", source: "AI", approvedAt: earlier },
    { id: "a2", kind: "DM", text: "AI draft", source: "AI", approvedAt: null },
    { id: "gone", kind: "PUBLIC", text: "Old", source: "MANUAL", approvedAt: earlier },
  ];
  const v = (over: Record<string, unknown>) => ({ kind: "DM" as const, weight: 1, source: "MANUAL" as const, ...over }) as never;

  it("keeps ids and approval of unchanged text, deletes what is missing", () => {
    const plan = planVariantSave(existing, [v({ id: "m1", text: "Manual" }), v({ id: "a1", text: "AI approved", source: "AI" })], now);
    expect(plan.deleteIds.sort()).toEqual(["a2", "gone"]);
    expect(plan.updates.map((u) => [u.id, u.data.approvedAt])).toEqual([
      ["m1", earlier],
      ["a1", earlier],
    ]);
    expect(plan.creates).toEqual([]);
  });

  it("approves manual text on save, including edits", () => {
    const plan = planVariantSave(existing, [v({ id: "m1", text: "Manual edited" }), v({ text: "Brand new" })], now);
    expect(plan.updates[0].data.approvedAt).toEqual(now);
    expect(plan.creates[0]).toMatchObject({ text: "Brand new", source: "MANUAL", approvedAt: now, sort: 1 });
  });

  it("keeps AI text unapproved unless explicitly approved", () => {
    const plan = planVariantSave(
      existing,
      [
        v({ id: "a2", text: "AI draft", source: "AI" }),
        v({ text: "New AI", source: "AI" }),
        v({ text: "New AI ok", source: "AI", approved: true }),
      ],
      now
    );
    expect(plan.updates[0].data.approvedAt).toBeNull();
    expect(plan.creates.map((c) => c.approvedAt)).toEqual([null, now]);
  });

  it("drops the approval of edited AI text, and of anything explicitly withdrawn", () => {
    const plan = planVariantSave(
      existing,
      [v({ id: "a1", text: "AI approved, edited", source: "AI" }), v({ id: "m1", text: "Manual", approved: false })],
      now
    );
    expect(plan.updates.map((u) => u.data.approvedAt)).toEqual([null, null]);
  });

  it("keeps the stored source, so AI text cannot be relabelled as manual", () => {
    const plan = planVariantSave(existing, [v({ id: "a2", text: "AI draft", source: "MANUAL" })], now);
    expect(plan.updates[0].data).toMatchObject({ source: "AI", approvedAt: null });
  });

  it("numbers sort order per kind", () => {
    const plan = planVariantSave(
      [],
      [v({ text: "D1" }), v({ kind: "PUBLIC", text: "P1" }), v({ text: "D2" }), v({ kind: "PUBLIC", text: "P2" })],
      now
    );
    expect(plan.creates.map((c) => `${c.kind}${c.sort}`)).toEqual(["DM0", "PUBLIC0", "DM1", "PUBLIC1"]);
  });
});

describe("quick replies and follow-ups", () => {
  it("validates quick replies", () => {
    const qr = (over: Record<string, unknown>) => ({ label: "Narx", action: "MESSAGE", responseText: "100", ...over });
    expect(quickRepliesInputSchema.safeParse({ quickReplies: [qr({})] }).success).toBe(true);
    expect(issue(quickRepliesInputSchema, { quickReplies: [qr({ responseText: "" })] })).toMatch(/"Narx" tugmasi/);
    expect(quickRepliesInputSchema.safeParse({ quickReplies: [qr({ action: "HANDOFF", responseText: null })] }).success).toBe(true);
    expect(issue(quickRepliesInputSchema, { quickReplies: [qr({ label: "x".repeat(21) })] })).toMatch(/20 belgidan/);
    expect(issue(quickRepliesInputSchema, { quickReplies: [qr({}), qr({ label: "narx" })] })).toMatch(/takrorlanmasin/);
    const fourteen = Array.from({ length: 14 }, (_, i) => qr({ label: `B${i}` }));
    expect(issue(quickRepliesInputSchema, { quickReplies: fourteen })).toMatch(/13 ta/);
    expect(issue(quickRepliesInputSchema, { quickReplies: [qr({ action: "FLOW" })] })).toBeTruthy();
  });

  it("validates follow-up steps against the 24-hour window", () => {
    const step = (delayMinutes: number) => ({ delayMinutes, condition: "NO_REPLY", message: "Eslatma" });
    expect(followUpsInputSchema.safeParse({ steps: [step(60), step(1380)] }).success).toBe(true);
    expect(issue(followUpsInputSchema, { steps: [step(1381)] })).toMatch(/24 soatlik/);
    expect(issue(followUpsInputSchema, { steps: [step(0)] })).toMatch(/kamida 1/);
    expect(issue(followUpsInputSchema, { steps: [step(120), step(60)] })).toMatch(/keyinroq/);
    expect(issue(followUpsInputSchema, { steps: [1, 2, 3, 4, 5, 6].map((n) => step(n * 10)) })).toMatch(/5 ta/);
  });

  it("caps backtrack at Meta's 7 days", () => {
    expect(backtrackInputSchema.safeParse({ days: 7 }).success).toBe(true);
    expect(issue(backtrackInputSchema, { days: 8 })).toMatch(/7 kun/);
    expect(issue(backtrackInputSchema, { days: 0 })).toMatch(/1 kun/);
  });
});

describe("workspace scoping", () => {
  it("looks campaigns up by workspace and COMMENT type", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue(null);
    const result = await updateCommentCampaign("ws1", "c-other", commentCampaignSchema.parse(base));
    expect(result).toEqual({ ok: false, status: 404, error: "Kampaniya topilmadi" });
    expect(mocks.prisma.triggerCampaign.findFirst.mock.calls[0][0].where).toEqual({
      id: "c-other",
      workspaceId: "ws1",
      triggerType: "COMMENT",
    });
    expect(mocks.prisma.triggerCampaign.update).not.toHaveBeenCalled();
  });

  it("refuses an Instagram account from another workspace", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue({
      id: "c1",
      openingButtonLabel: null,
      instagramAccount: { instagramId: "ig" },
      _count: { quickReplies: 0, followUpSteps: 0 },
    });
    mocks.prisma.instagramAccount.findFirst.mockResolvedValue(null);
    const result = await updateCommentCampaign("ws1", "c1", commentCampaignSchema.parse(base));
    expect(result.ok).toBe(false);
    expect(mocks.prisma.instagramAccount.findFirst.mock.calls[0][0].where).toEqual({ id: "acc1", workspaceId: "ws1" });
  });

  it("removing the button removes quick replies and follow-ups in the campaign's transaction", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue({
      id: "c1",
      openingButtonLabel: "Narx",
      instagramAccount: { instagramId: "ig" },
      _count: { quickReplies: 2, followUpSteps: 1 },
    });
    mocks.prisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc1", instagramId: "ig" });
    mocks.prisma.triggerCampaign.update.mockReturnValue("update-op");
    mocks.prisma.triggerFollowUpRun.updateMany.mockReturnValue("cancel-runs-op");
    mocks.prisma.triggerQuickReply.deleteMany.mockReturnValue("delete-replies-op");
    mocks.prisma.triggerFollowUpStep.deleteMany.mockReturnValue("delete-steps-op");

    const result = await updateCommentCampaign("ws1", "c1", commentCampaignSchema.parse(base));
    expect(result).toEqual({ ok: true, data: { id: "c1" } });
    expect(mocks.prisma.$transaction).toHaveBeenCalledWith([
      "update-op",
      "cancel-runs-op",
      "delete-replies-op",
      "delete-steps-op",
    ]);
    expect(mocks.prisma.triggerFollowUpRun.updateMany.mock.calls[0][0]).toMatchObject({
      where: { step: { campaignId: "c1" }, status: "SCHEDULED" },
      data: { status: "CANCELLED" },
    });
    expect(mocks.prisma.triggerQuickReply.deleteMany).toHaveBeenCalledWith({ where: { campaignId: "c1" } });
    expect(mocks.prisma.triggerFollowUpStep.deleteMany).toHaveBeenCalledWith({ where: { campaignId: "c1" } });
  });

  it("refuses the button while a stored DM variant is longer than the button template allows", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue({
      id: "c1",
      openingButtonLabel: null,
      instagramAccount: { instagramId: "ig" },
      _count: { quickReplies: 0, followUpSteps: 0 },
    });
    mocks.prisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc1", instagramId: "ig" });
    mocks.prisma.triggerReplyVariant.findMany.mockResolvedValue([{ text: "x".repeat(641) }]);
    const input = commentCampaignSchema.parse({ ...base, openingButtonLabel: "Narx", mainMessage: "Katalog" });
    const result = await updateCommentCampaign("ws1", "c1", input);
    expect(result).toMatchObject({ ok: false, status: 422 });
    if (!result.ok) expect(result.error).toMatch(/640/);
    expect(mocks.prisma.triggerCampaign.update).not.toHaveBeenCalled();
  });

  it("caps DM variants at 640 characters on a campaign with the button", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue({
      id: "c1",
      openingButtonLabel: "Narx",
      instagramAccount: { instagramId: "ig" },
      _count: { quickReplies: 0, followUpSteps: 0 },
    });
    const long = variantsInputSchema.parse({ variants: [{ kind: "DM", text: "x".repeat(641) }] }).variants;
    expect(await saveVariants("ws1", "c1", long)).toMatchObject({ ok: false, status: 422 });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();

    // a long public reply variant is judged by its own limit, not the button's
    const publicOnly = variantsInputSchema.parse({ variants: [{ kind: "PUBLIC", text: "x".repeat(300) }] }).variants;
    mocks.prisma.triggerReplyVariant.findMany.mockResolvedValue([]);
    expect(await saveVariants("ws1", "c1", publicOnly)).toMatchObject({ ok: true });
  });

  it("toggling a campaign drops the cached account gate and claim list", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue({
      id: "c1",
      openingButtonLabel: null,
      instagramAccount: { instagramId: "ig" },
      _count: { quickReplies: 0, followUpSteps: 0 },
    });
    expect(await setCommentCampaignActive("ws1", "c1", false)).toBe(true);
    expect(mocks.prisma.triggerCampaign.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { active: false } });
    expect(mocks.forgetAccountGate).toHaveBeenCalledWith("ig");

    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue(null);
    expect(await setCommentCampaignActive("ws1", "c-other", true)).toBe(false);
  });

  it("needs the opening button before quick replies are saved", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue({
      id: "c1",
      openingButtonLabel: null,
      instagramAccount: { instagramId: "ig" },
      _count: { quickReplies: 0, followUpSteps: 0 },
    });
    const result = await saveQuickReplies("ws1", "c1", [{ label: "Narx", action: "MESSAGE", responseText: "100" }]);
    expect(result).toMatchObject({ ok: false, status: 422 });
    if (!result.ok) expect(result.error).toMatch(/Meta/);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("scopes variant approval and follow-up cancel to the workspace", async () => {
    mocks.prisma.triggerReplyVariant.findFirst.mockResolvedValue(null);
    expect(await setVariantApproved("ws1", "v-other", true)).toMatchObject({ ok: false, status: 404 });
    expect(mocks.prisma.triggerReplyVariant.findFirst.mock.calls[0][0].where).toEqual({
      id: "v-other",
      campaign: { workspaceId: "ws1", triggerType: "COMMENT" },
    });

    mocks.prisma.triggerExecution.findFirst.mockResolvedValue(null);
    expect(await cancelExecutionFollowUps("ws1", "e-other")).toMatchObject({ ok: false, status: 404 });
    expect(mocks.cancelFollowUps).not.toHaveBeenCalled();

    mocks.prisma.triggerExecution.findFirst.mockResolvedValue({ id: "e1" });
    mocks.cancelFollowUps.mockResolvedValue(2);
    expect(await cancelExecutionFollowUps("ws1", "e1")).toEqual({ ok: true, data: { cancelled: 2 } });
    expect(mocks.cancelFollowUps).toHaveBeenCalledWith("ws1", "e1", expect.any(String));
  });

  it("turns an engine backtrack refusal into a 422 with its message", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue({
      id: "c1",
      openingButtonLabel: null,
      instagramAccount: { instagramId: "ig" },
      _count: { quickReplies: 0, followUpSteps: 0 },
    });
    mocks.startBacktrack.mockRejectedValue(new Error("Kampaniya o'chiq"));
    expect(await startCampaignBacktrack("ws1", "c1", 3)).toEqual({ ok: false, status: 422, error: "Kampaniya o'chiq" });
    mocks.startBacktrack.mockRejectedValueOnce(Object.assign(new Error("allaqachon ishlayapti"), { status: 409 }));
    expect(await startCampaignBacktrack("ws1", "c1", 3)).toEqual({ ok: false, status: 409, error: "allaqachon ishlayapti" });
    mocks.startBacktrack.mockResolvedValue({ runId: "r1" });
    expect(await startCampaignBacktrack("ws1", "c1", 3)).toEqual({ ok: true, data: { runId: "r1" } });
  });
});
