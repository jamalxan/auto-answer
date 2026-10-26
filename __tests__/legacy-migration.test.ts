/**
 * Audit 2026-10-26: old (production) campaigns move into the Comment 2.0
 * engine through plan → shadow comparison → cutover, reversibly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));

import {
  cutoverLegacyMigration,
  isReadyForCutover,
  listLegacyMigrations,
  planLegacyMigration,
  recordShadowSamples,
  resetShadowCacheForTests,
  rollbackLegacyMigration,
  SHADOW_DAYS,
  startLegacyShadow,
  type LegacyAutomation,
} from "@/lib/campaigns/legacy-migration";

const WS = "ws1";
const DAY = 24 * 60 * 60 * 1000;

function automation(over: Partial<LegacyAutomation> = {}): LegacyAutomation & Record<string, unknown> {
  return {
    id: "auto1",
    workspaceId: WS,
    instagramAccountId: "acc1",
    name: "Salom",
    postId: "media1",
    pendingNextReel: false,
    matchAnyPost: false,
    keywords: ["salom", "Assalomu aleykum"],
    matchAnyWord: false,
    wholeWordMatch: true,
    dmTriggerEnabled: false,
    handoffToAssistant: false,
    dmMessage: "Assalomu alaykum! Narxlar: ...",
    openingDmEnabled: false,
    openingDmMessage: null,
    openingDmButtonLabel: null,
    linkButtonLabel: null,
    requireFollow: false,
    followUpEnabled: false,
    followUpMessage: null,
    followUpDelayMinutes: 0,
    publicReplyEnabled: true,
    publicReplyMessage: null,
    publicReplyMessages: ["Direct'ga yozdik 🙌", "DM'ni tekshiring"],
    isActive: true,
    scheduledPostId: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  resetDb();
  resetShadowCacheForTests();
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann" });
});

describe("plan", () => {
  it("maps keywords, post, public replies; opening DM becomes button + main message", () => {
    const plan = planLegacyMigration(automation({ openingDmEnabled: true, openingDmMessage: "Salom! Tugmani bosing", openingDmButtonLabel: "Olish" }));
    expect(plan.blockers).toEqual([]);
    expect(plan.campaign).toMatchObject({
      matchingMode: "CONTAINS",
      keywords: ["salom", "Assalomu aleykum"],
      mediaScope: "SPECIFIC",
      mediaIds: ["media1"],
      responseMessage: "Salom! Tugmani bosing",
      openingButtonLabel: "Olish",
      mainMessage: "Assalomu alaykum! Narxlar: ...",
      publicReplyEnabled: true,
    });
    expect(plan.publicReplies).toHaveLength(2);
  });

  it("any word + any post → EVERY / ANY; follow-up capped to the 24h window", () => {
    const plan = planLegacyMigration(automation({ matchAnyWord: true, matchAnyPost: true, postId: null, followUpEnabled: true, followUpMessage: "Savol bormi?", followUpDelayMinutes: 2000 }));
    expect(plan.campaign).toMatchObject({ matchingMode: "EVERY", keywords: [], mediaScope: "ANY", mediaIds: [] });
    expect(plan.followUp).toEqual({ delayMinutes: 23 * 60, message: "Savol bormi?" });
    expect(plan.notes.join(" ")).toMatch(/qisqartirildi/);
  });

  it("features the new engine lacks block the move instead of silently changing behaviour", () => {
    const plan = planLegacyMigration(automation({ requireFollow: true, linkButtonLabel: "Havola", handoffToAssistant: true, pendingNextReel: true }));
    expect(plan.blockers).toHaveLength(4);
  });
});

describe("shadow → cutover → rollback", () => {
  it("records both engines' decisions once per comment and never sends", async () => {
    db.seed("automation", automation());
    const { migrationId, triggerCampaignId } = await startLegacyShadow(WS, "auto1");
    const copy = db.rows("triggerCampaign").find((c) => c.id === triggerCampaignId)!;
    expect(copy.active).toBe(false);
    expect(db.rows("triggerReplyVariant").filter((v) => v.campaignId === triggerCampaignId)).toHaveLength(2);

    await recordShadowSamples({ instagramId: "ig1", commentId: "c1", text: "Salom!", mediaId: "media1" });
    await recordShadowSamples({ instagramId: "ig1", commentId: "c1", text: "Salom!", mediaId: "media1" }); // reconciler re-sees it
    await recordShadowSamples({ instagramId: "ig1", commentId: "c2", text: "narxi qancha", mediaId: "media1" });
    await recordShadowSamples({ instagramId: "ig1", commentId: "c3", text: "salom", mediaId: "other" });
    const samples = db.rows("legacyMigrationSample").filter((s) => s.migrationId === migrationId);
    expect(samples).toHaveLength(3);
    expect(samples.every((s) => s.legacyMatched === s.newMatched)).toBe(true);
    expect(samples.find((s) => s.commentId === "c1")).toMatchObject({ legacyMatched: true, newMatched: true });
    // Nothing was sent by either engine here.
    expect(db.rows("triggerExecution")).toHaveLength(0);
  });

  it("refuses an early cutover without a reason, allows a forced one, and rolls back exactly", async () => {
    db.seed("automation", automation());
    const { migrationId, triggerCampaignId } = await startLegacyShadow(WS, "auto1");
    await expect(cutoverLegacyMigration(WS, migrationId)).rejects.toMatchObject({ status: 409 });

    await cutoverLegacyMigration(WS, migrationId, { force: true, reason: "kam ishlatiladi" });
    expect(db.rows("triggerCampaign").find((c) => c.id === triggerCampaignId)!.active).toBe(true);
    expect(db.rows("automation")[0].isActive).toBe(false);
    expect(db.rows("legacyCampaignMigration")[0]).toMatchObject({ status: "CUTOVER", forcedReason: "kam ishlatiladi" });

    await rollbackLegacyMigration(WS, migrationId);
    expect(db.rows("triggerCampaign").find((c) => c.id === triggerCampaignId)!.active).toBe(false);
    expect(db.rows("automation")[0].isActive).toBe(true);
    expect(db.rows("legacyCampaignMigration")[0].status).toBe("ROLLED_BACK");
  });

  it("a clean comparison of 14 days unlocks the plain cutover", () => {
    const start = new Date("2026-10-01T00:00:00Z");
    const clean = { samples: 40, agreed: 40, legacyOnly: 0, newOnly: 0 };
    expect(isReadyForCutover(clean, start, new Date(start.getTime() + (SHADOW_DAYS - 1) * DAY))).toBe(false);
    expect(isReadyForCutover(clean, start, new Date(start.getTime() + SHADOW_DAYS * DAY))).toBe(true);
    expect(isReadyForCutover({ ...clean, legacyOnly: 1 }, start, new Date(start.getTime() + 30 * DAY))).toBe(false);
  });

  it("a blocked campaign cannot start; another workspace cannot touch the migration", async () => {
    db.seed("automation", automation({ requireFollow: true }));
    await expect(startLegacyShadow(WS, "auto1")).rejects.toMatchObject({ status: 422 });
    await expect(startLegacyShadow("other", "auto1")).rejects.toMatchObject({ status: 404 });
  });

  it("the list shows the plan and the shadow counts with disagreements", async () => {
    db.seed("automation", automation({ wholeWordMatch: false }));
    const { migrationId } = await startLegacyShadow(WS, "auto1");
    db.seed("legacyMigrationSample", { migrationId, commentId: "x", commentText: "salomlar", legacyMatched: true, newMatched: false });
    const [view] = await listLegacyMigrations(WS);
    expect(view.plan.notes.length).toBeGreaterThan(0);
    expect(view.migration).toMatchObject({ status: "SHADOW", stats: { samples: 1, legacyOnly: 1, newOnly: 0 }, readyForCutover: false });
    expect(view.migration!.disagreements[0].commentText).toBe("salomlar");
  });
});
