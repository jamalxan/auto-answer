/**
 * Foundation — Instagram connection status (TZ §4.1): every status, rule
 * order, and the real Meta 190 subcodes/messages as tokenLastError stores them.
 */

import { describe, expect, it } from "vitest";
import {
  classifyBrokenReason,
  deriveConnectionStatus,
  type ConnectionFields,
} from "../lib/foundation/connection-status";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function account(overrides: Partial<ConnectionFields> = {}): ConnectionFields {
  return {
    accessToken: "enc:token",
    tokenExpiresAt: new Date(NOW.getTime() + 50 * DAY),
    tokenStatus: "ACTIVE",
    tokenCheckedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    tokenLastError: null,
    connectedAt: new Date(NOW.getTime() - 30 * DAY),
    ...overrides,
  };
}

// As lib/meta/client handleResponse formats them.
const meta = (message: string, sub: number | "-") =>
  `${message} (/me) [code=190 sub=${sub} type=OAuthException trace=AbC]`;

describe("deriveConnectionStatus", () => {
  it("CONNECTED: active, freshly checked, far from expiry", () => {
    const result = deriveConnectionStatus(account(), NOW);
    expect(result).toMatchObject({ status: "CONNECTED", tone: "success", action: { kind: "none" } });
    expect(result.expiresInDays).toBe(50);
  });

  it("CONNECTED when Meta gave no expiry date", () => {
    expect(deriveConnectionStatus(account({ tokenExpiresAt: null }), NOW).status).toBe("CONNECTED");
  });

  it("EXPIRING within 10 days, with a reconnect action", () => {
    const result = deriveConnectionStatus(account({ tokenExpiresAt: new Date(NOW.getTime() + 3 * DAY) }), NOW);
    expect(result).toMatchObject({ status: "EXPIRING", tone: "warning", action: { kind: "reconnect" } });
    expect(result.explanation).toContain("3 kun");
  });

  it("EXPIRING boundary: exactly 10 days is expiring, 11 is not", () => {
    expect(deriveConnectionStatus(account({ tokenExpiresAt: new Date(NOW.getTime() + 10 * DAY) }), NOW).status).toBe("EXPIRING");
    expect(deriveConnectionStatus(account({ tokenExpiresAt: new Date(NOW.getTime() + 11 * DAY) }), NOW).status).toBe("CONNECTED");
  });

  it("EXPIRED when tokenExpiresAt is past, even if the last check said ACTIVE", () => {
    const result = deriveConnectionStatus(account({ tokenExpiresAt: new Date(NOW.getTime() - 1000) }), NOW);
    expect(result).toMatchObject({ status: "EXPIRED", tone: "error", action: { kind: "reconnect" } });
  });

  it("EXPIRED from a BROKEN 190/463", () => {
    const result = deriveConnectionStatus(
      account({ tokenStatus: "BROKEN", tokenLastError: meta("Error validating access token: Session has expired on Tuesday", 463) }),
      NOW
    );
    expect(result.status).toBe("EXPIRED");
  });

  it("EXPIRED from Meta's wording when the subcode is missing", () => {
    const result = deriveConnectionStatus(
      account({ tokenStatus: "BROKEN", tokenLastError: meta("Error validating access token: Session has expired", "-") }),
      NOW
    );
    expect(result.status).toBe("EXPIRED");
  });

  it.each([
    [458, "Error validating access token: The user has not authorized application 123", "ruxsat"],
    [459, "Error validating access token: The user is enrolled in a blocking, logged-in checkpoint", "checkpoint"],
    [460, "Error validating access token: The session has been invalidated because the user changed their password", "parol"],
    [464, "Error validating access token: Sessions for the user are not allowed because the user is not a confirmed user", "tasdiq"],
  ])("RECONNECT_REQUIRED from 190/%i", (sub, message, word) => {
    const result = deriveConnectionStatus(account({ tokenStatus: "BROKEN", tokenLastError: meta(message, sub) }), NOW);
    expect(result).toMatchObject({ status: "RECONNECT_REQUIRED", tone: "error", action: { kind: "reconnect" } });
    expect(result.explanation.toLowerCase()).toContain(word);
  });

  it("RECONNECT_REQUIRED from the message alone (no subcode)", () => {
    const result = deriveConnectionStatus(
      account({ tokenStatus: "BROKEN", tokenLastError: meta("The session has been invalidated because the user changed their password", "-") }),
      NOW
    );
    expect(result.status).toBe("RECONNECT_REQUIRED");
  });

  it("RECONNECT_REQUIRED when Meta's deauthorize callback wiped the token", () => {
    const result = deriveConnectionStatus(
      account({ accessToken: "", tokenStatus: "BROKEN", tokenLastError: "App removed in Instagram (Meta deauthorize callback)" }),
      NOW
    );
    expect(result.status).toBe("RECONNECT_REQUIRED");
  });

  it("INVALID from 190/467 and from an undecryptable token", () => {
    expect(
      deriveConnectionStatus(account({ tokenStatus: "BROKEN", tokenLastError: meta("Invalid OAuth access token - Cannot parse access token", 467) }), NOW).status
    ).toBe("INVALID");
    const undecryptable = deriveConnectionStatus(
      account({ tokenStatus: "BROKEN", tokenLastError: "Stored token cannot be decrypted (ENCRYPTION_KEY changed?)" }),
      NOW
    );
    expect(undecryptable.status).toBe("INVALID");
    expect(undecryptable.explanation).toContain("shifrlash");
    expect(
      deriveConnectionStatus(account({ tokenStatus: "BROKEN", tokenLastError: "Assistant could not decrypt the Instagram token" }), NOW).status
    ).toBe("INVALID");
  });

  it("INVALID for a generic 190 with no recognisable reason", () => {
    expect(deriveConnectionStatus(account({ tokenStatus: "BROKEN", tokenLastError: meta("Something odd", "-") }), NOW).status).toBe("INVALID");
  });

  it("reads the trigger engine's technical format too", () => {
    const technical = `TokenExpiredError code=190: ${meta("Error validating access token: Session has expired", 463)}`;
    expect(deriveConnectionStatus(account({ tokenStatus: "BROKEN", tokenLastError: technical }), NOW).status).toBe("EXPIRED");
  });

  it("ERROR (recheck) when BROKEN for an unknown reason", () => {
    for (const reason of [null, "Something exploded"]) {
      const result = deriveConnectionStatus(account({ tokenStatus: "BROKEN", tokenLastError: reason }), NOW);
      expect(result).toMatchObject({ status: "ERROR", tone: "error", action: { kind: "recheck" } });
    }
  });

  it("ERROR (warning) when the health check is stale or never ran", () => {
    const stale = deriveConnectionStatus(account({ tokenCheckedAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) }), NOW);
    expect(stale).toMatchObject({ status: "ERROR", tone: "warning", action: { kind: "recheck" } });
    expect(deriveConnectionStatus(account({ tokenCheckedAt: null, connectedAt: null }), NOW).status).toBe("ERROR");
    // A brand-new connection counts its connect time as the last check.
    expect(
      deriveConnectionStatus(account({ tokenCheckedAt: null, connectedAt: new Date(NOW.getTime() - 60_000) }), NOW).status
    ).toBe("CONNECTED");
  });

  it("DISCONNECTED when the user removed the token", () => {
    const result = deriveConnectionStatus(
      account({ accessToken: "", tokenStatus: "BROKEN", tokenLastError: "Disconnected by user", tokenExpiresAt: null }),
      NOW
    );
    expect(result).toMatchObject({ status: "DISCONNECTED", tone: "muted", action: { kind: "reconnect" } });
  });

  it("rule order: DISCONNECTED beats EXPIRED, EXPIRED beats a stale check", () => {
    expect(
      deriveConnectionStatus(account({ accessToken: "", tokenExpiresAt: new Date(NOW.getTime() - DAY) }), NOW).status
    ).toBe("DISCONNECTED");
    expect(
      deriveConnectionStatus(
        account({ tokenExpiresAt: new Date(NOW.getTime() - DAY), tokenCheckedAt: new Date(NOW.getTime() - 5 * DAY) }),
        NOW
      ).status
    ).toBe("EXPIRED");
  });

  it("accepts ISO strings (API payloads) as well as Dates", () => {
    const result = deriveConnectionStatus(
      account({ tokenExpiresAt: new Date(NOW.getTime() + 2 * DAY).toISOString(), tokenCheckedAt: NOW.toISOString() }),
      NOW
    );
    expect(result.status).toBe("EXPIRING");
  });

  it("never shows raw OAuthException text to the user", () => {
    const result = deriveConnectionStatus(account({ tokenStatus: "BROKEN", tokenLastError: meta("x", 463) }), NOW);
    expect(`${result.title} ${result.explanation}`).not.toMatch(/OAuthException|#190|code=/);
  });
});

describe("classifyBrokenReason", () => {
  it("treats non-token errors as unknown", () => {
    expect(classifyBrokenReason("Rate limited [code=4 sub=- type=x trace=y]").kind).toBe("unknown");
    expect(classifyBrokenReason(null).kind).toBe("unknown");
  });
});
