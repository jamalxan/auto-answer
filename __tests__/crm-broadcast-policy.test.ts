/**
 * ETAP 5.4 — broadcast eligibility policy, opt-out words and batching.
 * Pure functions only.
 */

import { describe, expect, it, vi } from "vitest";

// Only for the equivalence check against the trigger engine's isWindowOpen.
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: vi.fn() }));

import {
  batchSize,
  evaluateRecipient,
  isActiveHandoff,
  isBroadcastWindowOpen,
  isOptOutMessage,
  isUnderFrequencyCap,
  OPT_OUT_WORDS,
  summarizeEligibility,
  windowClosesAt,
  type RecipientPolicyInput,
} from "../lib/crm/broadcast-policy";
import { INELIGIBILITY_LABELS, INELIGIBILITY_REASONS } from "../lib/crm/types";
import { isWindowOpen } from "../lib/triggers/followups";

const NOW = new Date("2026-10-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursAgo = (h: number) => minutesAgo(h * 60);

function input(overrides: Partial<RecipientPolicyInput> = {}): RecipientPolicyInput {
  return {
    now: NOW,
    workspaceSuspended: false,
    tokenStatus: "ACTIVE",
    lastInboundAt: hoursAgo(1),
    optedOutAt: null,
    lastBroadcastSentAt: null,
    frequencyCapHours: 24,
    handoffState: "AI_ACTIVE",
    alreadyInBroadcast: false,
    ...overrides,
  };
}

describe("isBroadcastWindowOpen", () => {
  it("is open for 24h minus a 5-minute margin after the last inbound", () => {
    expect(isBroadcastWindowOpen(hoursAgo(1), NOW)).toBe(true);
    expect(isBroadcastWindowOpen(minutesAgo(24 * 60 - 6), NOW)).toBe(true);
    expect(isBroadcastWindowOpen(minutesAgo(24 * 60 - 5), NOW)).toBe(false);
    expect(isBroadcastWindowOpen(hoursAgo(48), NOW)).toBe(false);
    expect(isBroadcastWindowOpen(null, NOW)).toBe(false);
  });

  it("agrees with lib/triggers/followups isWindowOpen", () => {
    for (const minutes of [0, 30, 600, 24 * 60 - 6, 24 * 60 - 5, 24 * 60 - 4, 24 * 60, 3000]) {
      const at = minutesAgo(minutes);
      expect(isBroadcastWindowOpen(at, NOW)).toBe(isWindowOpen({ openedAt: null, lastInboundAt: at }, NOW));
    }
    expect(isBroadcastWindowOpen(null, NOW)).toBe(isWindowOpen({ openedAt: null, lastInboundAt: null }, NOW));
  });

  it("reports when the window closes for sends", () => {
    expect(windowClosesAt(hoursAgo(1))?.toISOString()).toBe("2026-10-17T10:55:00.000Z");
    expect(windowClosesAt(null)).toBeNull();
  });
});

describe("evaluateRecipient", () => {
  it("is eligible for a healthy account and a person who wrote an hour ago", () => {
    const result = evaluateRecipient(input());
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.snapshot).toEqual({
      evaluatedAt: NOW.toISOString(),
      workspaceSuspended: false,
      tokenStatus: "ACTIVE",
      lastInboundAt: hoursAgo(1).toISOString(),
      windowOpen: true,
      windowClosesAt: "2026-10-17T10:55:00.000Z",
      optedOutAt: null,
      lastBroadcastSentAt: null,
      frequencyCapHours: 24,
      handoffState: "AI_ACTIVE",
      alreadyInBroadcast: false,
    });
  });

  it("the design's three recipients: 1h ago / 2 days ago / opted out → one send, two reasons", () => {
    const results = [
      evaluateRecipient(input({ lastInboundAt: hoursAgo(1) })),
      evaluateRecipient(input({ lastInboundAt: hoursAgo(48) })),
      evaluateRecipient(input({ lastInboundAt: hoursAgo(1), optedOutAt: hoursAgo(5) })),
    ];
    expect(results.map((r) => r.reason ?? "OK")).toEqual(["OK", "WINDOW_CLOSED", "OPTED_OUT"]);
    expect(results[1].label).toBe("24 soatlik oyna yopilgan");
    expect(results[2].label).toBe("Obunadan chiqqan");
    const summary = summarizeEligibility(results);
    expect(summary.total).toBe(3);
    expect(summary.eligible).toBe(1);
    expect(summary.ineligible).toBe(2);
    expect(summary.byReason.WINDOW_CLOSED).toBe(1);
    expect(summary.byReason.OPTED_OUT).toBe(1);
    expect(summary.byReason.NO_INBOUND).toBe(0);
  });

  it("gives every reason, in the documented order of precedence", () => {
    expect(evaluateRecipient(input({ workspaceSuspended: true, tokenStatus: "BROKEN", lastInboundAt: null })).reason).toBe("SUSPENDED");
    expect(evaluateRecipient(input({ tokenStatus: "BROKEN", lastInboundAt: null })).reason).toBe("TOKEN_BROKEN");
    expect(evaluateRecipient(input({ tokenStatus: null })).reason).toBe("TOKEN_BROKEN");
    expect(evaluateRecipient(input({ lastInboundAt: null, optedOutAt: NOW })).reason).toBe("NO_INBOUND");
    expect(evaluateRecipient(input({ lastInboundAt: hoursAgo(30), optedOutAt: NOW })).reason).toBe("WINDOW_CLOSED");
    expect(evaluateRecipient(input({ optedOutAt: NOW, lastBroadcastSentAt: hoursAgo(2) })).reason).toBe("OPTED_OUT");
    expect(evaluateRecipient(input({ lastBroadcastSentAt: hoursAgo(2), handoffState: "OPERATOR_ACTIVE" })).reason).toBe("FREQUENCY_CAP");
    expect(evaluateRecipient(input({ handoffState: "OPERATOR_ACTIVE", alreadyInBroadcast: true })).reason).toBe("OPERATOR_ACTIVE");
    expect(evaluateRecipient(input({ handoffState: "HANDOFF_PENDING" })).reason).toBe("OPERATOR_ACTIVE");
    expect(evaluateRecipient(input({ alreadyInBroadcast: true })).reason).toBe("DUPLICATE");
  });

  it("handoff: pending and operator-active count, closed and AI do not", () => {
    expect(isActiveHandoff("HANDOFF_PENDING")).toBe(true);
    expect(isActiveHandoff("OPERATOR_ACTIVE")).toBe(true);
    expect(isActiveHandoff("CLOSED")).toBe(false);
    expect(isActiveHandoff("AI_ACTIVE")).toBe(false);
    expect(isActiveHandoff(null)).toBe(false);
    expect(evaluateRecipient(input({ handoffState: "CLOSED" })).eligible).toBe(true);
    expect(evaluateRecipient(input({ handoffState: undefined })).eligible).toBe(true);
  });

  it("frequency cap: inside the cap blocks, at or past it allows, 0 disables", () => {
    expect(isUnderFrequencyCap(hoursAgo(23), 24, NOW)).toBe(true);
    expect(isUnderFrequencyCap(hoursAgo(24), 24, NOW)).toBe(false);
    expect(isUnderFrequencyCap(hoursAgo(1), 0, NOW)).toBe(false);
    expect(isUnderFrequencyCap(null, 24, NOW)).toBe(false);
    expect(evaluateRecipient(input({ lastBroadcastSentAt: hoursAgo(25) })).eligible).toBe(true);
    expect(evaluateRecipient(input({ lastBroadcastSentAt: hoursAgo(1), frequencyCapHours: 0 })).eligible).toBe(true);
  });

  it("the Uzbek label map covers every reason", () => {
    for (const reason of INELIGIBILITY_REASONS) expect(INELIGIBILITY_LABELS[reason]).toBeTruthy();
    expect(INELIGIBILITY_LABELS.OPERATOR_ACTIVE).toBe("Operator bilan suhbatda");
  });

  it("summarizeEligibility starts every reason at zero", () => {
    const summary = summarizeEligibility([]);
    expect(summary).toEqual({
      total: 0,
      eligible: 0,
      ineligible: 0,
      byReason: Object.fromEntries(INELIGIBILITY_REASONS.map((r) => [r, 0])),
    });
  });
});

describe("isOptOutMessage", () => {
  it("matches the documented stop words in any script, as whole words", () => {
    expect(isOptOutMessage("STOP")).toBe(true);
    expect(isOptOutMessage("stop.")).toBe(true);
    expect(isOptOutMessage("Стоп")).toBe(true);
    expect(isOptOutMessage("to'xtat")).toBe(true);
    expect(isOptOutMessage("To‘xtating iltimos")).toBe(true);
    expect(isOptOutMessage("тўхтат")).toBe(true);
    expect(isOptOutMessage("Отпишите меня")).toBe(true);
    expect(isOptOutMessage("хочу отписаться")).toBe(true);
    expect(isOptOutMessage("unsubscribe")).toBe(true);
  });

  it("does not opt out on ordinary messages or partial words", () => {
    expect(isOptOutMessage("Narxi qancha?")).toBe(false);
    expect(isOptOutMessage("nonstop")).toBe(false);
    expect(isOptOutMessage("stopper")).toBe(false);
    expect(isOptOutMessage("")).toBe(false);
    expect(isOptOutMessage(null)).toBe(false);
  });

  it("exports the word list for the settings UI", () => {
    expect(OPT_OUT_WORDS).toEqual(expect.arrayContaining(["stop", "to'xtat", "тўхтат", "отпишите", "отписаться", "unsubscribe"]));
  });
});

describe("batchSize", () => {
  it("floors throttle × interval / 60 with a minimum of one", () => {
    expect(batchSize(100)).toBe(8);
    expect(batchSize(100, 5)).toBe(8);
    expect(batchSize(120, 5)).toBe(10);
    expect(batchSize(60, 1)).toBe(1);
    expect(batchSize(5, 5)).toBe(1);
    expect(batchSize(750, 60)).toBe(750);
  });

  it("is zero when the throttle (or interval) is not positive", () => {
    expect(batchSize(0)).toBe(0);
    expect(batchSize(-5)).toBe(0);
    expect(batchSize(100, 0)).toBe(0);
    expect(batchSize(Number.NaN)).toBe(0);
  });
});
