/**
 * Comment Automation 2.0 — follow-up rules (TZ 13), payload parsing and the
 * backtrack filter (TZ 11). Pure functions only.
 */

import { describe, expect, it, vi } from "vitest";

// The modules under test also hold the database / Telegram side; none of it runs here.
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: vi.fn() }));

import {
  decideFollowUp,
  followUpAttempt,
  isWindowOpen,
  stepsForMoment,
  WINDOW_CLOSED_REASON,
  type FollowUpExecutionState,
} from "../lib/triggers/followups";
import { buildQuickReplies, parseC2Payload } from "../lib/triggers/direct-handler";
import { classifyBacktrackComment, clampBacktrackDays } from "../lib/triggers/backtrack";
import { isPrivateReplyExpired, openPayload } from "../lib/triggers/comment-handler";

const NOW = new Date("2026-10-15T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursAgo = (h: number) => minutesAgo(h * 60);

function state(overrides: Partial<FollowUpExecutionState> = {}): FollowUpExecutionState {
  return { stoppedAt: null, stopReason: null, openedAt: null, lastInboundAt: null, sentAt: hoursAgo(2), ...overrides };
}

describe("isWindowOpen", () => {
  it("is open for 24h minus a 5-minute margin after the last tap or message", () => {
    expect(isWindowOpen(state({ openedAt: hoursAgo(1) }), NOW)).toBe(true);
    expect(isWindowOpen(state({ openedAt: minutesAgo(24 * 60 - 6) }), NOW)).toBe(true);
    expect(isWindowOpen(state({ openedAt: minutesAgo(24 * 60 - 5) }), NOW)).toBe(false);
    expect(isWindowOpen(state({ openedAt: hoursAgo(30), lastInboundAt: hoursAgo(3) }), NOW)).toBe(true);
  });

  it("is closed when the person never tapped or wrote", () => {
    expect(isWindowOpen(state(), NOW)).toBe(false);
  });
});

describe("decideFollowUp", () => {
  it("sends an ALWAYS step inside the window", () => {
    expect(decideFollowUp({ now: NOW, condition: "ALWAYS", execution: state({ openedAt: hoursAgo(1), lastInboundAt: hoursAgo(1) }) })).toEqual({
      action: "send",
    });
  });

  it("cancels a stopped execution with its reason", () => {
    expect(
      decideFollowUp({ now: NOW, condition: "ALWAYS", execution: state({ openedAt: hoursAgo(1), stoppedAt: hoursAgo(0.5), stopReason: "Mijoz javob yozdi" }) })
    ).toEqual({ action: "cancel", reason: "Mijoz javob yozdi" });
  });

  it("cancels when the person already bought (stop on purchase)", () => {
    expect(
      decideFollowUp({ now: NOW, condition: "ALWAYS", execution: state({ openedAt: hoursAgo(1) }), purchase: "Sotib olish signali: lead yaratildi" })
    ).toEqual({ action: "cancel", reason: "Sotib olish signali: lead yaratildi" });
    expect(decideFollowUp({ now: NOW, condition: "ALWAYS", execution: state({ openedAt: hoursAgo(1) }), purchase: null }).action).toBe("send");
  });

  it("NO_REPLY skips when the person wrote after the tap", () => {
    const opened = hoursAgo(3);
    expect(decideFollowUp({ now: NOW, condition: "NO_REPLY", execution: state({ openedAt: opened, lastInboundAt: opened }) }).action).toBe("send");
    expect(decideFollowUp({ now: NOW, condition: "NO_REPLY", execution: state({ openedAt: opened, lastInboundAt: hoursAgo(1) }) }).action).toBe("skip");
  });

  it("NO_CLICK skips once the button was tapped", () => {
    expect(decideFollowUp({ now: NOW, condition: "NO_CLICK", execution: state({ openedAt: hoursAgo(1) }) }).action).toBe("skip");
  });

  it("NO_CLICK without a tap or a message has no window: skipped", () => {
    expect(decideFollowUp({ now: NOW, condition: "NO_CLICK", execution: state() })).toEqual({
      action: "skip",
      reason: WINDOW_CLOSED_REASON,
    });
    // ...but someone who wrote without tapping can still get it
    expect(decideFollowUp({ now: NOW, condition: "NO_CLICK", execution: state({ lastInboundAt: hoursAgo(1) }) }).action).toBe("send");
  });

  it("skips when the 24h window has closed", () => {
    expect(decideFollowUp({ now: NOW, condition: "ALWAYS", execution: state({ openedAt: hoursAgo(25), lastInboundAt: hoursAgo(25) }) })).toEqual({
      action: "skip",
      reason: WINDOW_CLOSED_REASON,
    });
  });
});

describe("follow-up scheduling and retries", () => {
  const steps = [
    { id: "a", condition: "ALWAYS" as const },
    { id: "b", condition: "NO_REPLY" as const },
    { id: "c", condition: "NO_CLICK" as const },
  ];

  it("with a button: NO_CLICK at send, the rest at the tap", () => {
    expect(stepsForMoment(steps, true, "sent").map((s) => s.id)).toEqual(["c"]);
    expect(stepsForMoment(steps, true, "opened").map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("without a button: everything at send", () => {
    expect(stepsForMoment(steps, false, "sent").map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(stepsForMoment(steps, false, "opened")).toEqual([]);
  });

  it("reads the try number from the reason", () => {
    expect(followUpAttempt(null)).toBe(1);
    expect(followUpAttempt("Qayta urinish 2/3: Instagram API vaqtincha javob bermadi.")).toBe(2);
  });
});

describe("c2 payloads", () => {
  it("parses open and quick-reply payloads", () => {
    expect(openPayload("exec1")).toBe("c2:exec1:open");
    expect(parseC2Payload("c2:exec1:open")).toEqual({ executionId: "exec1", action: "open" });
    expect(parseC2Payload("c2:exec1:qr:qr9")).toEqual({ executionId: "exec1", action: "qr", quickReplyId: "qr9" });
  });

  it("rejects anything else", () => {
    for (const payload of [null, undefined, "", "reveal:abc", "followcheck:abc", "c2:", "c2:exec1", "c2:exec1:qr", "c2:exec1:open:x", "c2:e:zz"]) {
      expect(parseC2Payload(payload), String(payload)).toBeNull();
    }
  });

  it("builds quick replies: phone chip for LEAD_CAPTURE, max 13, titles ≤ 20", () => {
    const qrs = Array.from({ length: 15 }, (_, i) => ({
      id: `q${i}`,
      campaignId: "c",
      label: i === 0 ? "Telefon raqamimni yuboraman" : `Tugma ${i}`,
      action: i === 0 ? ("LEAD_CAPTURE" as const) : ("MESSAGE" as const),
      responseText: null,
      sort: i,
      createdAt: new Date(2026, 0, 1, 0, i),
    }));
    const built = buildQuickReplies("exec1", qrs);
    expect(built).toHaveLength(13);
    expect(built[0]).toEqual({ title: "Telefon raqamimni yu", payload: "c2:exec1:qr:q0", contentType: "user_phone_number" });
    expect(built[1]).toMatchObject({ contentType: "text", payload: "c2:exec1:qr:q1" });
  });
});

describe("7-day private reply rule", () => {
  it("expires exactly at 7 days", () => {
    expect(isPrivateReplyExpired(hoursAgo(24 * 7 - 1), NOW)).toBe(false);
    expect(isPrivateReplyExpired(hoursAgo(24 * 7), NOW)).toBe(true);
  });
});

describe("backtrack filter", () => {
  const base = {
    now: NOW,
    sinceMs: NOW.getTime() - 7 * 24 * 3600_000,
    ownInstagramId: "OWN",
    matches: true,
    alreadyKnown: false,
  };
  const comment = (hours: number, from: string | null = "USER") => ({
    id: "c1",
    timestamp: hoursAgo(hours).toISOString(),
    from: from ? { id: from } : undefined,
  });

  it("queues a fresh matching comment", () => {
    expect(classifyBacktrackComment({ ...base, comment: comment(5) })).toBe("queue");
  });

  it("applies the skip rules in order", () => {
    expect(classifyBacktrackComment({ ...base, sinceMs: NOW.getTime() - 24 * 3600_000, comment: comment(30) })).toBe("outside_window");
    expect(classifyBacktrackComment({ ...base, comment: comment(24 * 7 - 1) })).toBe("expired");
    expect(classifyBacktrackComment({ ...base, comment: { id: "c1", timestamp: "", from: { id: "USER" } } })).toBe("expired");
    expect(classifyBacktrackComment({ ...base, comment: comment(5, "OWN") })).toBe("own");
    expect(classifyBacktrackComment({ ...base, comment: comment(5, null) })).toBe("no_author");
    expect(classifyBacktrackComment({ ...base, matches: false, comment: comment(5) })).toBe("no_match");
    expect(classifyBacktrackComment({ ...base, alreadyKnown: true, comment: comment(5) })).toBe("duplicate");
  });

  it("clamps days to 1..7", () => {
    expect([0, 1, 3.7, 7, 30, Number.NaN].map(clampBacktrackDays)).toEqual([1, 1, 3, 7, 7, 1]);
  });
});
