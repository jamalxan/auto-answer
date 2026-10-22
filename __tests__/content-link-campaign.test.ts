/**
 * ETAP 13 — post ↔ comment-to-DM campaign binding (FR-L1…FR-L5): a linked
 * campaign waits silently, the publish transaction activates it on the real
 * media id, cancel / delete pauses it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db, resetDb } from "./helpers/db-instance";
import { vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import {
  activateLinkedCampaigns,
  attachCampaignToPost,
  captionMentionsKeyword,
  linkedCampaignSummary,
  pauseLinkedCampaigns,
} from "@/lib/content/link-campaign";

const WS = "ws1";

beforeEach(() => {
  resetDb();
  db.seed("scheduledPost", { id: "p1", workspaceId: WS, instagramAccountId: "acc1", type: "REEL", status: "DRAFT" });
  db.seed("automation", { id: "au1", workspaceId: WS, instagramAccountId: "acc1", name: "Narx", keywords: ["narx"], dmMessage: "x", isActive: true, pendingNextReel: true, postId: "old" });
  db.seed("triggerCampaign", { id: "tc1", workspaceId: WS, instagramAccountId: "acc1", name: "Promo", triggerType: "COMMENT", keywords: ["promo"], responseMessage: "y", active: true, mediaScope: "ANY", mediaIds: [] });
});

describe("attachCampaignToPost", () => {
  it("parks an Automation on the post: inactive, no post, not waiting for the next reel", async () => {
    await attachCampaignToPost(WS, "p1", { automationId: "au1" });
    expect(db.rows("automation")[0]).toMatchObject({ scheduledPostId: "p1", isActive: false, postId: null, pendingNextReel: false });
  });

  it("parks a TriggerCampaign on the post with an empty SPECIFIC media scope", async () => {
    await attachCampaignToPost(WS, "p1", { triggerCampaignId: "tc1" });
    expect(db.rows("triggerCampaign")[0]).toMatchObject({ scheduledPostId: "p1", active: false, mediaScope: "SPECIFIC", mediaIds: [] });
  });

  it("refuses a campaign of another workspace or another account", async () => {
    db.seed("automation", { id: "au2", workspaceId: "other", instagramAccountId: "acc1", name: "X", keywords: [], dmMessage: "x" });
    await expect(attachCampaignToPost(WS, "p1", { automationId: "au2" })).rejects.toMatchObject({ status: 404 });
    db.seed("automation", { id: "au3", workspaceId: WS, instagramAccountId: "acc2", name: "X", keywords: [], dmMessage: "x" });
    await expect(attachCampaignToPost(WS, "p1", { automationId: "au3" })).rejects.toMatchObject({ status: 400 });
  });

  it("detaches with null", async () => {
    await attachCampaignToPost(WS, "p1", { automationId: "au1" });
    await attachCampaignToPost(WS, "p1", null);
    expect(db.rows("automation")[0].scheduledPostId).toBeNull();
  });
});

describe("activateLinkedCampaigns", () => {
  it("writes the media id and switches both kinds on", async () => {
    await attachCampaignToPost(WS, "p1", { automationId: "au1" });
    await attachCampaignToPost(WS, "p1", { triggerCampaignId: "tc1" });
    const r = await activateLinkedCampaigns(db.client(), "p1", "17890000");
    expect(r).toEqual({ automations: 1, triggers: 1 });
    expect(db.rows("automation")[0]).toMatchObject({ postId: "17890000", isActive: true });
    expect(db.rows("triggerCampaign")[0]).toMatchObject({ mediaIds: ["17890000"], mediaScope: "SPECIFIC", active: true });
  });
});

describe("pauseLinkedCampaigns / summary", () => {
  it("pauses without unlinking", async () => {
    await attachCampaignToPost(WS, "p1", { automationId: "au1" });
    await pauseLinkedCampaigns("p1");
    expect(db.rows("automation")[0]).toMatchObject({ scheduledPostId: "p1", isActive: false });
  });

  it("summarises the waiting campaign for the UI", async () => {
    await attachCampaignToPost(WS, "p1", { automationId: "au1" });
    expect(await linkedCampaignSummary("p1")).toEqual({ kind: "automation", id: "au1", name: "Narx", keywords: ["narx"], active: false, waiting: true });
    expect(await linkedCampaignSummary("nope")).toBeNull();
  });
});

describe("captionMentionsKeyword", () => {
  it("is case-insensitive and needs at least one keyword in the caption", () => {
    expect(captionMentionsKeyword("Yozing: NARX", ["narx"])).toBe(true);
    expect(captionMentionsKeyword("salom", ["narx", "promo"])).toBe(false);
    expect(captionMentionsKeyword(null, ["narx"])).toBe(false);
  });
});
