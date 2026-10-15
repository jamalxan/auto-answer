/**
 * ETAP 3 — pure parts: webhook shapes (click-to-Direct ad, ig.me link,
 * reactions, story mention) and the DM-side campaign selector.
 */

import { describe, expect, it } from "vitest";
import { normalizeWebhookPayload } from "@/lib/triggers/normalize";
import { selectDmCampaign, type DmInput, type DmMatchableCampaign } from "@/lib/triggers/matching";

const ACCOUNT = "17841400000000001";
const USER = "6000000000000001";
const TS = 1760000000000;

function messaging(item: Record<string, unknown>) {
  return { object: "instagram", entry: [{ id: ACCOUNT, time: TS, messaging: [{ sender: { id: USER }, recipient: { id: ACCOUNT }, timestamp: TS, ...item }] }] };
}

describe("normalize — ETAP 3 payloads", () => {
  it("keeps the referral of a click-to-Direct ad message", () => {
    const [event] = normalizeWebhookPayload(
      messaging({
        message: {
          mid: "aWdfZAG1faXRlbToxOklHTWVzc2FnZAWQ",
          text: "Salom, kurs narxi qancha?",
          referral: {
            ref: "",
            ad_id: "120210000000000001",
            source: "ADS",
            type: "OPEN_THREAD",
            ads_context_data: { ad_title: "IELTS kursi", photo_url: "https://scontent.cdninstagram.com/ad.jpg" },
          },
        },
      })
    );
    expect(event).toMatchObject({
      type: "DIRECT_MESSAGE",
      messageId: "aWdfZAG1faXRlbToxOklHTWVzc2FnZAWQ",
      text: "Salom, kurs narxi qancha?",
      referralSource: "ADS",
      adId: "120210000000000001",
    });
    expect(event.ref).toBeUndefined(); // empty ref is no ref
  });

  it("turns an ig.me link open without a message into an empty DIRECT_MESSAGE with a stable id", () => {
    const payload = messaging({ referral: { ref: "bahor_aksiya", source: "SHORTLINK", type: "OPEN_THREAD" } });
    const [event] = normalizeWebhookPayload(payload);
    expect(event).toMatchObject({
      type: "DIRECT_MESSAGE",
      text: "",
      ref: "bahor_aksiya",
      referralSource: "SHORTLINK",
      messageId: `ref:${USER}:${TS}`,
    });
    // a redelivery builds the same id → the unique row drops it
    expect(normalizeWebhookPayload(payload)[0].messageId).toBe(event.messageId);
  });

  it("stores reactions and unreactions as MESSAGE_REACTION", () => {
    const [react] = normalizeWebhookPayload(
      messaging({ reaction: { mid: "mid.reacted", action: "react", reaction: "love", emoji: "❤️" } })
    );
    expect(react).toMatchObject({
      type: "MESSAGE_REACTION",
      reaction: "❤️",
      reactedMid: "mid.reacted",
      text: "react",
      messageId: `reaction:mid.reacted:${USER}:react:${TS}`,
    });
    const [unreact] = normalizeWebhookPayload(messaging({ reaction: { mid: "mid.reacted", action: "unreact" } }));
    expect(unreact).toMatchObject({ type: "MESSAGE_REACTION", text: "unreact", reaction: undefined });
    expect(unreact.messageId).not.toBe(react.messageId);
  });

  it("drops the account's own reactions", () => {
    const payload = {
      object: "instagram",
      entry: [{ id: ACCOUNT, messaging: [{ sender: { id: ACCOUNT }, recipient: { id: USER }, reaction: { mid: "m", action: "react" } }] }],
    };
    expect(normalizeWebhookPayload(payload)).toEqual([]);
  });

  it("keeps story mentions (url only) and plain DMs as before", () => {
    const events = normalizeWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          messaging: [
            { sender: { id: USER }, timestamp: TS, message: { mid: "mid.mention", attachments: [{ type: "story_mention", payload: { url: "https://lookaside.fbsbx.com/story" } }] } },
            { sender: { id: USER }, timestamp: TS, message: { mid: "mid.dm", text: "narx" } },
          ],
        },
      ],
    });
    expect(events.map((e) => [e.type, e.text])).toEqual([
      ["STORY_MENTION", ""],
      ["DIRECT_MESSAGE", "narx"],
    ]);
    expect(events[0].storyUrl).toBe("https://lookaside.fbsbx.com/story");
    expect(events[1].referralSource).toBeUndefined();
  });
});

// ─── selectDmCampaign ─────────────────────────────────────────────────────────

let n = 0;
function campaign(overrides: Partial<DmMatchableCampaign> = {}): DmMatchableCampaign {
  return {
    id: `c${++n}`,
    triggerType: "DIRECT_MESSAGE",
    active: true,
    keywords: [],
    matchingMode: "EVERY",
    intents: [],
    priority: 0,
    createdAt: new Date(2026, 0, n),
    audience: "ANY",
    reopenAfterHours: 72,
    cooldownHours: 24,
    sourceFilter: "ANY",
    adIds: [],
    refs: [],
    ...overrides,
  };
}

const AT = new Date("2026-10-15T12:00:00Z");
function input(overrides: Partial<DmInput> = {}): DmInput {
  return { type: "DIRECT_MESSAGE", text: "Narxi qancha?", firstInteraction: false, hoursSincePreviousInbound: 1, at: AT, ...overrides };
}

describe("selectDmCampaign", () => {
  it("ranks EXACT > CONTAINS > INTENT > EVERY", () => {
    const every = campaign();
    const intent = campaign({ matchingMode: "CONTAINS", intents: ["PRICE"] });
    const contains = campaign({ matchingMode: "CONTAINS", keywords: ["narxi"] });
    const exact = campaign({ matchingMode: "EXACT", keywords: ["narxi qancha"] });
    expect(selectDmCampaign([every, intent, contains, exact], input())).toMatchObject({ campaign: exact, matchKind: "EXACT" });
    expect(selectDmCampaign([every, intent, contains], input()).campaign).toBe(contains);
    expect(selectDmCampaign([every, intent], input())).toMatchObject({ campaign: intent, intent: "PRICE" });
  });

  it("a source- or audience-filtered campaign beats ANY, then priority, then the oldest", () => {
    const general = campaign();
    const returning = campaign({ audience: "RETURNING_CONTACT" });
    const ads = campaign({ sourceFilter: "ADS" });
    const ad = input({ referralSource: "ADS", adId: "ad1" });
    expect(selectDmCampaign([general, returning], ad).campaign).toBe(returning);
    expect(selectDmCampaign([general, returning, ads], ad).campaign).toBe(ads);
    const important = campaign({ priority: 5 });
    expect(selectDmCampaign([general, important], input()).campaign).toBe(important);
    expect(selectDmCampaign([campaign({ createdAt: new Date(2027, 0, 1) }), general], input()).campaign).toBe(general);
  });

  it("audience: new, returning, reopened", () => {
    const fresh = campaign({ audience: "NEW_CONTACT" });
    const back = campaign({ audience: "RETURNING_CONTACT" });
    const reopened = campaign({ audience: "REOPENED", reopenAfterHours: 48 });
    expect(selectDmCampaign([fresh, back], input({ firstInteraction: true, hoursSincePreviousInbound: null })).campaign).toBe(fresh);
    expect(selectDmCampaign([fresh, back], input()).campaign).toBe(back);
    expect(selectDmCampaign([reopened], input({ hoursSincePreviousInbound: 47 })).campaign).toBeNull();
    expect(selectDmCampaign([reopened], input({ hoursSincePreviousInbound: 49 })).campaign).toBe(reopened);
    expect(selectDmCampaign([reopened], input({ firstInteraction: true, hoursSincePreviousInbound: null })).ignoredReason).toContain("Auditoriya");
  });

  it("source: ADS (any ad or listed ads) and LINK (any ref or listed refs)", () => {
    const anyAd = campaign({ sourceFilter: "ADS" });
    const oneAd = campaign({ sourceFilter: "ADS", adIds: ["ad1"] });
    expect(selectDmCampaign([oneAd], input({ referralSource: "ADS", adId: "ad2" })).campaign).toBeNull();
    expect(selectDmCampaign([oneAd], input({ referralSource: "ADS", adId: "ad1" })).campaign).toBe(oneAd);
    expect(selectDmCampaign([anyAd], input({ referralSource: "ADS", adId: "ad2" })).campaign).toBe(anyAd);
    expect(selectDmCampaign([anyAd], input()).ignoredReason).toContain("Manba");

    const promo = campaign({ sourceFilter: "LINK", refs: ["promo"] });
    expect(selectDmCampaign([promo], input({ ref: "promo", text: "" })).campaign).toBe(promo);
    expect(selectDmCampaign([promo], input({ ref: "other" })).campaign).toBeNull();
    expect(selectDmCampaign([campaign({ sourceFilter: "LINK" })], input({ ref: "x" })).campaign).not.toBeNull();
  });

  it("cooldown skips a campaign that answered this person recently; the next one may answer", () => {
    const narx = campaign({ matchingMode: "CONTAINS", keywords: ["narxi"], cooldownHours: 24 });
    const welcome = campaign({ cooldownHours: 0 });
    const lastSentAt = new Map([[narx.id, new Date(AT.getTime() - 2 * 3600_000)]]);
    expect(selectDmCampaign([narx], input({ lastSentAt })).ignoredReason).toContain("cooldown");
    expect(selectDmCampaign([narx, welcome], input({ lastSentAt })).campaign).toBe(welcome);
    const old = new Map([[narx.id, new Date(AT.getTime() - 25 * 3600_000)]]);
    expect(selectDmCampaign([narx], input({ lastSentAt: old })).campaign).toBe(narx);
  });

  it("only campaigns of the event's type; mentions with EVERY", () => {
    const mention = campaign({ triggerType: "STORY_MENTION" });
    expect(selectDmCampaign([mention], input()).campaign).toBeNull();
    expect(selectDmCampaign([mention], input({ type: "STORY_MENTION", text: "" })).matchKind).toBe("EVERY");
    expect(selectDmCampaign([campaign({ triggerType: "STORY_MENTION", matchingMode: "CONTAINS", keywords: ["x"] })], input({ type: "STORY_MENTION", text: "" })).campaign).toBeNull();
  });
});
