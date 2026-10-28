/**
 * ETAP 3 DM-trigger service: validation (Uzbek zod rules — mentions answer
 * every mention, ad / link lists, cooldown bounds, quick-reply and follow-up
 * limits, no opening button), workspace + trigger-type scoping of the write
 * paths, and the simulator mapping.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    triggerCampaign: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    triggerReplyVariant: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    triggerQuickReply: { findMany: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    triggerFollowUpStep: { findMany: vi.fn(), update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    triggerExecution: { findFirst: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  cancelFollowUps: vi.fn(),
  simulateDmTrigger: vi.fn(),
  forgetAccountGate: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: mocks.forgetAccountGate }));
vi.mock("@/lib/triggers/followups", () => ({ cancelFollowUps: mocks.cancelFollowUps }));
vi.mock("@/lib/triggers/dm-trigger-handler", () => ({ simulateDmTrigger: mocks.simulateDmTrigger }));
vi.mock("@/lib/triggers/keywords", () => ({
  BUILT_IN_INTENTS: [
    { key: "PRICE", label: "Narx", examples: ["narx", "цена"] },
    { key: "ADDRESS", label: "Manzil", examples: ["manzil"] },
  ],
  normalizeForMatch: (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim(),
}));

import {
  automationHref,
  automationKind,
  createDmCampaign,
  dmCampaignSchema,
  dmFollowUpsInputSchema,
  dmSimulateInputSchema,
  dmVariantsInputSchema,
  firstIssue,
  MENTION_NO_SOURCE,
  NO_CLICK_NOT_OFFERED,
  NO_OPENING_BUTTON,
  NO_PUBLIC_VARIANTS,
  quickRepliesInputSchema,
  saveDmFollowUpSteps,
  saveDmQuickReplies,
  saveDmVariants,
  setDmCampaignActive,
  setDmVariantApproved,
  simulateDmDryRun,
  updateDmCampaign,
} from "@/lib/triggers/dm-trigger-service";

const base = {
  name: "Narx so'raganlar",
  instagramAccountId: "acc1",
  triggerType: "DIRECT_MESSAGE",
  matchingMode: "CONTAINS",
  keywords: ["narx"],
  responseMessage: "Salom! Narxlar ro'yxatini yuboraman.",
};

function issue(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown) {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
  return firstIssue(result.error as Parameters<typeof firstIssue>[0]);
}

const found = { id: "c1", triggerType: "DIRECT_MESSAGE", instagramAccount: { instagramId: "ig" } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dmCampaignSchema", () => {
  it("accepts a minimal Direct campaign and fills defaults", () => {
    const parsed = dmCampaignSchema.parse(base);
    expect(parsed).toMatchObject({
      triggerType: "DIRECT_MESSAGE",
      audience: "ANY",
      cooldownHours: 24,
      reopenAfterHours: 72,
      sourceFilter: "ANY",
      adIds: [],
      refs: [],
      priority: 0,
      replyMode: "RANDOM",
      active: true,
    });
    expect(parsed).not.toHaveProperty("openingButtonLabel");
    expect(parsed).not.toHaveProperty("mainMessage");
  });

  it("needs a trigger type and a keyword or intent unless every message is answered", () => {
    expect(dmCampaignSchema.safeParse({ ...base, triggerType: "COMMENT" }).success).toBe(false);
    expect(issue(dmCampaignSchema, { ...base, keywords: [] })).toMatch(/kalit so'z/);
    expect(dmCampaignSchema.safeParse({ ...base, keywords: [], intents: ["PRICE"] }).success).toBe(true);
    expect(dmCampaignSchema.parse({ ...base, matchingMode: "EVERY" }).keywords).toEqual([]);
    expect(issue(dmCampaignSchema, { ...base, intents: ["NOPE"] })).toMatch(/Noma'lum intent/);
  });

  it("answers every mention: a Story Mention has no text, so keywords and intents are dropped", () => {
    const parsed = dmCampaignSchema.parse({
      ...base,
      triggerType: "STORY_MENTION",
      matchingMode: "CONTAINS",
      keywords: ["narx"],
      intents: ["PRICE"],
    });
    expect(parsed.matchingMode).toBe("EVERY");
    expect(parsed.keywords).toEqual([]);
    expect(parsed.intents).toEqual([]);
    // without keywords a mention is still valid
    expect(dmCampaignSchema.safeParse({ ...base, triggerType: "STORY_MENTION", keywords: [] }).success).toBe(true);
  });

  it("refuses an ad or link filter on a mention", () => {
    expect(issue(dmCampaignSchema, { ...base, triggerType: "STORY_MENTION", sourceFilter: "ADS" })).toBe(MENTION_NO_SOURCE);
  });

  it("refuses the opening button and the main message — the window is already open", () => {
    expect(issue(dmCampaignSchema, { ...base, openingButtonLabel: "Narx" })).toBe(NO_OPENING_BUTTON);
    expect(issue(dmCampaignSchema, { ...base, mainMessage: "Katalog" })).toBe(NO_OPENING_BUTTON);
    // explicit empties (what a form sends) are fine
    expect(dmCampaignSchema.safeParse({ ...base, openingButtonLabel: null, mainMessage: "" }).success).toBe(true);
  });

  it("validates ad ids and keeps them only for ad campaigns", () => {
    const ads = dmCampaignSchema.parse({ ...base, sourceFilter: "ADS", adIds: ["120211234567890", "120211234567890", ""] });
    expect(ads.adIds).toEqual(["120211234567890"]);
    expect(issue(dmCampaignSchema, { ...base, sourceFilter: "ADS", adIds: ["reklama-1"] })).toMatch(/reklama ID emas/);
    expect(issue(dmCampaignSchema, { ...base, sourceFilter: "ADS", adIds: Array.from({ length: 51 }, (_, i) => `1000${i}0`) })).toMatch(
      /50 ta reklama/
    );
    // an empty list means "any ad"
    expect(dmCampaignSchema.parse({ ...base, sourceFilter: "ADS" }).adIds).toEqual([]);
    expect(dmCampaignSchema.parse({ ...base, sourceFilter: "ANY", adIds: ["120211234567890"] }).adIds).toEqual([]);
  });

  it("validates ig.me refs and keeps them only for link campaigns", () => {
    expect(dmCampaignSchema.parse({ ...base, sourceFilter: "LINK", refs: ["promo_oktabr", "bio-link"] }).refs).toEqual([
      "promo_oktabr",
      "bio-link",
    ]);
    expect(issue(dmCampaignSchema, { ...base, sourceFilter: "LINK", refs: ["promo oktabr"] })).toMatch(/yaroqsiz ref/);
    expect(issue(dmCampaignSchema, { ...base, sourceFilter: "LINK", refs: ["x".repeat(65)] })).toMatch(/yaroqsiz ref/);
    expect(issue(dmCampaignSchema, { ...base, sourceFilter: "LINK", refs: Array.from({ length: 51 }, (_, i) => `r${i}`) })).toMatch(
      /50 ta havola/
    );
    expect(dmCampaignSchema.parse({ ...base, sourceFilter: "ADS", refs: ["promo"] }).refs).toEqual([]);
  });

  it("bounds cooldown and reopen hours to 1…720", () => {
    expect(dmCampaignSchema.parse({ ...base, cooldownHours: 1 }).cooldownHours).toBe(1);
    expect(dmCampaignSchema.parse({ ...base, cooldownHours: 720 }).cooldownHours).toBe(720);
    expect(issue(dmCampaignSchema, { ...base, cooldownHours: 0 })).toMatch(/1…720/);
    expect(issue(dmCampaignSchema, { ...base, cooldownHours: 721 })).toMatch(/1…720/);
    expect(issue(dmCampaignSchema, { ...base, cooldownHours: 1.5 })).toMatch(/butun/);
    expect(issue(dmCampaignSchema, { ...base, audience: "REOPENED", reopenAfterHours: 0 })).toMatch(/1…720/);
    expect(dmCampaignSchema.parse({ ...base, audience: "REOPENED", reopenAfterHours: 48 }).reopenAfterHours).toBe(48);
  });

  it("needs the fallback text within Meta's 1000 characters", () => {
    expect(issue(dmCampaignSchema, { ...base, responseMessage: " " })).toMatch(/Zaxira/);
    expect(issue(dmCampaignSchema, { ...base, responseMessage: "x".repeat(1001) })).toMatch(/1000/);
  });
});

describe("child lists", () => {
  it("allows Direct variants only", () => {
    expect(issue(dmVariantsInputSchema, { variants: [{ kind: "PUBLIC", text: "Yubordik" }] })).toBe(NO_PUBLIC_VARIANTS);
    expect(dmVariantsInputSchema.safeParse({ variants: [{ kind: "DM", text: "Salom" }] }).success).toBe(true);
  });

  it("caps quick replies at Meta's 13 × 20 characters", () => {
    const reply = (label: string) => ({ label, action: "MESSAGE", responseText: "ok" });
    expect(quickRepliesInputSchema.safeParse({ quickReplies: Array.from({ length: 13 }, (_, i) => reply(`T${i}`)) }).success).toBe(true);
    expect(issue(quickRepliesInputSchema, { quickReplies: Array.from({ length: 14 }, (_, i) => reply(`T${i}`)) })).toMatch(/13/);
    expect(issue(quickRepliesInputSchema, { quickReplies: [reply("x".repeat(21))] })).toMatch(/20/);
  });

  it("offers no NO_CLICK follow-up and keeps the 5-step, 23-hour limits", () => {
    const step = (delayMinutes: number, condition = "ALWAYS") => ({ delayMinutes, condition, message: "Eslatma" });
    expect(dmFollowUpsInputSchema.safeParse({ steps: [step(60, "NO_REPLY")] }).success).toBe(true);
    expect(issue(dmFollowUpsInputSchema, { steps: [step(60, "NO_CLICK")] })).toBe(NO_CLICK_NOT_OFFERED);
    expect(issue(dmFollowUpsInputSchema, { steps: [1, 2, 3, 4, 5, 6].map((h) => step(h * 60)) })).toMatch(/5 ta/);
    expect(issue(dmFollowUpsInputSchema, { steps: [step(1381)] })).toMatch(/1380/);
    expect(issue(dmFollowUpsInputSchema, { steps: [step(0)] })).toMatch(/1 daqiqa/);
    expect(issue(dmFollowUpsInputSchema, { steps: [step(120), step(60)] })).toMatch(/keyinroq/);
  });
});

describe("workspace scoping", () => {
  it("looks campaigns up by workspace and the DM trigger types", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue(null);
    expect(await updateDmCampaign("ws1", "c-other", dmCampaignSchema.parse(base))).toEqual({
      ok: false,
      status: 404,
      error: "Kampaniya topilmadi",
    });
    expect(mocks.prisma.triggerCampaign.findFirst.mock.calls[0][0].where).toEqual({
      id: "c-other",
      workspaceId: "ws1",
      triggerType: { in: ["DIRECT_MESSAGE", "STORY_MENTION"] },
    });
    expect(await setDmCampaignActive("ws1", "c-other", false)).toBe(false);
    expect(mocks.prisma.triggerCampaign.update).not.toHaveBeenCalled();
  });

  it("refuses an Instagram account from another workspace", async () => {
    mocks.prisma.instagramAccount.findFirst.mockResolvedValue(null);
    const result = await createDmCampaign("ws1", dmCampaignSchema.parse(base));
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mocks.prisma.instagramAccount.findFirst.mock.calls[0][0].where).toEqual({ id: "acc1", workspaceId: "ws1" });
    expect(mocks.prisma.triggerCampaign.create).not.toHaveBeenCalled();
  });

  it("stores no comment-only settings and drops the account gate", async () => {
    mocks.prisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc1", instagramId: "ig" });
    mocks.prisma.triggerCampaign.create.mockResolvedValue({ id: "c1" });
    expect(await createDmCampaign("ws1", dmCampaignSchema.parse({ ...base, sourceFilter: "LINK", refs: ["bio"] }))).toEqual({
      ok: true,
      data: { id: "c1" },
    });
    expect(mocks.prisma.triggerCampaign.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: "ws1",
      triggerType: "DIRECT_MESSAGE",
      sourceFilter: "LINK",
      refs: ["bio"],
      openingButtonLabel: null,
      mainMessage: null,
      publicReplyEnabled: false,
      mediaScope: "ANY",
    });
    expect(mocks.forgetAccountGate).toHaveBeenCalledWith("ig");
  });

  it("saves quick replies without an opening button", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue(found);
    mocks.prisma.triggerQuickReply.findMany.mockResolvedValue([]);
    const result = await saveDmQuickReplies("ws1", "c1", [{ label: "Narx", action: "MESSAGE", responseText: "100 000" }]);
    expect(result.ok).toBe(true);
    expect(mocks.prisma.$transaction).toHaveBeenCalled();
  });

  it("refuses public variants and NO_CLICK steps at the service too (422)", async () => {
    mocks.prisma.triggerCampaign.findFirst.mockResolvedValue(found);
    expect(
      await saveDmVariants("ws1", "c1", [{ kind: "PUBLIC", text: "x", weight: 1, source: "MANUAL" }])
    ).toEqual({ ok: false, status: 422, error: NO_PUBLIC_VARIANTS });
    expect(
      await saveDmFollowUpSteps("ws1", "c1", [{ delayMinutes: 60, condition: "NO_CLICK", message: "x" }])
    ).toEqual({ ok: false, status: 422, error: NO_CLICK_NOT_OFFERED });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("scopes variant approval to the DM trigger types", async () => {
    mocks.prisma.triggerReplyVariant.findFirst.mockResolvedValue(null);
    expect(await setDmVariantApproved("ws1", "v-comment", true)).toMatchObject({ ok: false, status: 404 });
    expect(mocks.prisma.triggerReplyVariant.findFirst.mock.calls[0][0].where).toEqual({
      id: "v-comment",
      campaign: { workspaceId: "ws1", triggerType: { in: ["DIRECT_MESSAGE", "STORY_MENTION"] } },
    });
  });
});

describe("simulator", () => {
  it("passes the source the way the engine reads it, and nothing for a mention", async () => {
    mocks.prisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc1", instagramId: "ig" });
    mocks.simulateDmTrigger.mockResolvedValue({ matched: false, reason: "yo'q" });

    await simulateDmDryRun(
      "ws1",
      dmSimulateInputSchema.parse({ instagramAccountId: "acc1", text: "narx", referralSource: "ADS", adId: "120", ref: "x" })
    );
    expect(mocks.simulateDmTrigger.mock.calls[0][1]).toMatchObject({
      eventType: "DIRECT_MESSAGE",
      referralSource: "ADS",
      adId: "120",
      ref: undefined,
      contactState: "NEW",
    });

    await simulateDmDryRun(
      "ws1",
      dmSimulateInputSchema.parse({ instagramAccountId: "acc1", text: "salom", referralSource: "LINK", ref: "bio" })
    );
    expect(mocks.simulateDmTrigger.mock.calls[1][1]).toMatchObject({ referralSource: undefined, ref: "bio" });

    await simulateDmDryRun(
      "ws1",
      dmSimulateInputSchema.parse({ instagramAccountId: "acc1", eventType: "STORY_MENTION", text: "x", referralSource: "ADS" })
    );
    expect(mocks.simulateDmTrigger.mock.calls[2][1]).toMatchObject({
      eventType: "STORY_MENTION",
      text: "",
      referralSource: undefined,
      adId: undefined,
    });
  });

  it("refuses an account from another workspace", async () => {
    mocks.prisma.instagramAccount.findFirst.mockResolvedValue(null);
    const result = await simulateDmDryRun("ws1", dmSimulateInputSchema.parse({ instagramAccountId: "x", text: "a" }));
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.simulateDmTrigger).not.toHaveBeenCalled();
  });
});

describe("automation kinds", () => {
  it("names Direct campaigns by their source and links each kind to its builder", () => {
    expect(automationKind({ triggerType: "DIRECT_MESSAGE", sourceFilter: "ANY" })).toBe("DIRECT");
    expect(automationKind({ triggerType: "DIRECT_MESSAGE", sourceFilter: "ADS" })).toBe("AD_MESSAGE");
    expect(automationKind({ triggerType: "DIRECT_MESSAGE", sourceFilter: "LINK" })).toBe("LINK");
    expect(automationKind({ triggerType: "STORY_MENTION" })).toBe("STORY_MENTION");
    expect(automationKind({ triggerType: "COMMENT" })).toBeNull();
    expect(automationHref("STORY_REPLY", "a")).toBe("/triggers/a");
    expect(automationHref("LIVE_COMMENT", "a")).toBe("/comments/a");
    expect(automationHref("LINK", "a")).toBe("/triggers/dm/a");
  });
});
