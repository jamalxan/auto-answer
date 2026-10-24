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
  db.seed("automation", { id: "au1", workspaceId: WS, instagramAccountId: "acc1", name: "Narx", keywords: ["narx"], dmMessage: "x", isActive: true, pendingNextReel: true, postId: null });
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

  it("refuses a campaign that is live on a published post, but moves a stopped one (M5)", async () => {
    db.seed("automation", { id: "au4", workspaceId: WS, instagramAccountId: "acc1", name: "Live", keywords: [], dmMessage: "x", isActive: true, postId: "1789" });
    await expect(attachCampaignToPost(WS, "p1", { automationId: "au4" })).rejects.toMatchObject({ status: 400 });
    expect(db.rows("automation").find((a) => a.id === "au4")).toMatchObject({ isActive: true, postId: "1789" });
    db.seed("triggerCampaign", { id: "tc4", workspaceId: WS, instagramAccountId: "acc1", name: "Live", triggerType: "COMMENT", keywords: [], responseMessage: "y", active: true, mediaScope: "SPECIFIC", mediaIds: ["1789"] });
    await expect(attachCampaignToPost(WS, "p1", { triggerCampaignId: "tc4" })).rejects.toMatchObject({ status: 400 });
    db.seed("automation", { id: "au5", workspaceId: WS, instagramAccountId: "acc1", name: "Stopped", keywords: [], dmMessage: "x", isActive: false, postId: "1789" });
    await attachCampaignToPost(WS, "p1", { automationId: "au5" });
    expect(db.rows("automation").find((a) => a.id === "au5")).toMatchObject({ scheduledPostId: "p1", postId: null });
  });

  it("creates a new campaign inline (FR-L1) through the dashboard's writer, born waiting", async () => {
    await attachCampaignToPost(WS, "p1", { automationId: "au1" });
    await attachCampaignToPost(WS, "p1", {
      create: { keywords: ["Narx", "narx", ""], publicReply: "DM'ga yubordik", dmMessage: "Mana narxlar", link: "https://shop.uz/x", linkButtonLabel: "Ochish", requireFollow: true },
    });
    const created = db.rows("automation").find((a) => a.id !== "au1")!;
    expect(created).toMatchObject({
      workspaceId: WS,
      instagramAccountId: "acc1",
      name: "Post: Narx",
      keywords: ["Narx"],
      dmMessage: "Mana narxlar",
      publicReplyEnabled: true,
      publicReplyMessages: ["DM'ga yubordik"],
      publicReplyMessage: "DM'ga yubordik",
      linkButtonLabel: "Ochish",
      requireFollow: true,
      isActive: false,
      postId: null,
      pendingNextReel: false,
      matchAnyPost: false,
      scheduledPostId: "p1",
    });
    expect(created.reportShareSlug).toBeTruthy();
    expect(db.rows("trackedLink")).toEqual([expect.objectContaining({ automationId: created.id, destinationUrl: "https://shop.uz/x", workspaceId: WS })]);
    // the previously linked campaign is released — one post, one campaign
    expect(db.rows("automation").find((a) => a.id === "au1")!.scheduledPostId).toBeNull();
    expect(await linkedCampaignSummary("p1")).toMatchObject({ kind: "automation", id: created.id, waiting: true, active: false });
    await activateLinkedCampaigns(db.client(), "p1", "1799");
    expect(db.rows("automation").find((a) => a.id === created.id)).toMatchObject({ postId: "1799", isActive: true });
  });

  it("refuses an inline campaign without a keyword or DM text", async () => {
    await expect(attachCampaignToPost(WS, "p1", { create: { keywords: [" "], dmMessage: "x" } })).rejects.toMatchObject({ status: 400 });
    await expect(attachCampaignToPost(WS, "p1", { create: { keywords: ["narx"], dmMessage: "" } })).rejects.toMatchObject({ status: 400 });
  });

  it("inline campaign without a public reply or link stays minimal", async () => {
    await attachCampaignToPost(WS, "p1", { create: { keywords: ["promo"], dmMessage: "Kod: X" } });
    const created = db.rows("automation").find((a) => a.id !== "au1")!;
    expect(created).toMatchObject({ publicReplyEnabled: false, publicReplyMessages: [], requireFollow: false, linkButtonLabel: null, isActive: false });
    expect(db.rows("trackedLink")).toHaveLength(0);
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
