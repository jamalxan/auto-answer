/**
 * Trigger Engine — webhook payload → normalised events.
 */

import { describe, expect, it } from "vitest";
import { normalizeWebhookPayload, toDate } from "../lib/triggers/normalize";

const ACCOUNT = "17841400000000001";
const USER = "6000000000000001";

function messaging(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: 1760000000000,
        messaging: [
          {
            sender: { id: USER },
            recipient: { id: ACCOUNT },
            timestamp: 1760000001234,
            message,
            ...extra,
          },
        ],
      },
    ],
  };
}

describe("normalizeWebhookPayload", () => {
  it("recognises a story reply", () => {
    const [event] = normalizeWebhookPayload(
      messaging({
        mid: "mid.story.1",
        text: "  Narxi qancha?  ",
        reply_to: { story: { id: "18000000000000042", url: "https://cdn.example/story.jpg" } },
      })
    );
    expect(event).toMatchObject({
      type: "STORY_REPLY",
      instagramAccountId: ACCOUNT,
      senderId: USER,
      messageId: "mid.story.1",
      storyId: "18000000000000042",
      storyUrl: "https://cdn.example/story.jpg",
      text: "Narxi qancha?",
    });
    expect(event.timestamp.getTime()).toBe(1760000001234);
    expect(event.raw).toHaveProperty("message");
  });

  it("keeps a media-only story reply (no text)", () => {
    const [event] = normalizeWebhookPayload(
      messaging({
        mid: "mid.story.2",
        attachments: [{ type: "image", payload: { url: "https://cdn.example/x.jpg" } }],
        reply_to: { story: { id: "18000000000000042" } },
      })
    );
    expect(event.type).toBe("STORY_REPLY");
    expect(event.text).toBe("");
    expect(event.hasAttachment).toBe(true);
  });

  it("recognises a story mention", () => {
    const [event] = normalizeWebhookPayload(
      messaging({ mid: "mid.mention", attachments: [{ type: "story_mention", payload: { url: "https://cdn/m" } }] })
    );
    expect(event.type).toBe("STORY_MENTION");
    expect(event.storyUrl).toBe("https://cdn/m");
  });

  it("treats a plain DM and a reply to a message as DIRECT_MESSAGE", () => {
    const [plain] = normalizeWebhookPayload(messaging({ mid: "mid.dm", text: "salom" }));
    const [reply] = normalizeWebhookPayload(messaging({ mid: "mid.dm2", text: "ha", reply_to: { mid: "mid.dm" } }));
    expect(plain.type).toBe("DIRECT_MESSAGE");
    expect(reply.type).toBe("DIRECT_MESSAGE");
  });

  it("drops echoes, deletions, self-messages, read receipts and postbacks", () => {
    expect(normalizeWebhookPayload(messaging({ mid: "e", text: "x", is_echo: true }))).toEqual([]);
    expect(normalizeWebhookPayload(messaging({ mid: "d", is_deleted: true }))).toEqual([]);
    expect(
      normalizeWebhookPayload({
        object: "instagram",
        entry: [{ id: ACCOUNT, messaging: [{ sender: { id: ACCOUNT }, message: { mid: "s", text: "x" } }] }],
      })
    ).toEqual([]);
    expect(
      normalizeWebhookPayload({
        object: "instagram",
        entry: [
          {
            id: ACCOUNT,
            messaging: [
              { sender: { id: USER }, read: { watermark: 1 } },
              { sender: { id: USER }, postback: { payload: "x" } },
            ],
          },
        ],
      } as never)
    ).toEqual([]);
  });

  it("never produces STORY_REACTION: every reaction is kept as MESSAGE_REACTION (observation)", () => {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          messaging: [{ sender: { id: USER }, timestamp: 1760000000000, reaction: { mid: "m", action: "react", reaction: "love" } }],
        },
      ],
    };
    const events = normalizeWebhookPayload(payload as never);
    expect(events.map((e) => e.type)).toEqual(["MESSAGE_REACTION"]);
    expect(events[0]).toMatchObject({ reaction: "love", reactedMid: "m", text: "react" });
  });

  it("normalises comments and live comments", () => {
    const events = normalizeWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1760000000,
          changes: [
            { field: "comments", value: { id: "c1", text: "link", from: { id: USER, username: "ali" }, media: { id: "m1" } } },
            { field: "live_comments", value: { id: "c2", text: "salom", from: { id: USER, username: "ali" } } },
            { field: "comments", value: { id: "c3", text: "own", from: { id: ACCOUNT } } },
            { field: "mentions", value: { id: "c4" } },
          ],
        },
      ],
    });
    expect(events.map((e) => [e.type, e.messageId])).toEqual([
      ["COMMENT", "c1"],
      ["LIVE_COMMENT", "c2"],
    ]);
    expect(events[0]).toMatchObject({ senderUsername: "ali", mediaId: "m1" });
    // entry.time in seconds
    expect(events[0].timestamp.getTime()).toBe(1760000000 * 1000);
  });

  it("collapses the same message delivered twice in one payload", () => {
    const item = { sender: { id: USER }, message: { mid: "dup", text: "narx", reply_to: { story: { id: "s" } } } };
    const events = normalizeWebhookPayload({
      object: "instagram",
      entry: [
        { id: ACCOUNT, messaging: [item] },
        { id: ACCOUNT, messaging: [item] },
      ],
    });
    expect(events).toHaveLength(1);
  });

  it("ignores non-instagram objects and junk", () => {
    expect(normalizeWebhookPayload({ object: "page", entry: [] })).toEqual([]);
    expect(normalizeWebhookPayload(null as never)).toEqual([]);
    expect(normalizeWebhookPayload({ object: "instagram" })).toEqual([]);
  });
});

describe("toDate", () => {
  const fallback = new Date("2026-01-01T00:00:00Z");
  it("handles seconds, milliseconds, ISO strings and garbage", () => {
    expect(toDate(1760000000, fallback).getTime()).toBe(1760000000000);
    expect(toDate(1760000000000, fallback).getTime()).toBe(1760000000000);
    expect(toDate("2026-10-09T10:00:00+0000", fallback).toISOString()).toBe("2026-10-09T10:00:00.000Z");
    expect(toDate(undefined, fallback)).toBe(fallback);
    expect(toDate("nonsense", fallback)).toBe(fallback);
    expect(toDate(-5, fallback)).toBe(fallback);
  });
});
