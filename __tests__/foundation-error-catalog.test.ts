/**
 * Foundation — error catalog (TZ §5, §5.1): every Meta code we know, live
 * errors and stored strings, plus the workspace-scoped error feed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  dmLog: { findMany: vi.fn() },
  webhookEvent: { findMany: vi.fn() },
  operationalEvent: { findMany: vi.fn() },
  instagramEvent: { findMany: vi.fn() },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { MetaApiError, PermissionError, RateLimitError, TokenExpiredError } from "@/lib/meta/client";
import { ERROR_CATALOG, explainError, parseMetaCodes } from "@/lib/foundation/error-catalog";
import { loadErrorFeed } from "@/lib/foundation/errors-feed";

// What lib/meta/client handleResponse puts in error.message.
const tail = (code: number, sub: number | "-" = "-") => ` (/me/messages) [code=${code} sub=${sub} type=OAuthException trace=T1]`;

describe("parseMetaCodes", () => {
  it("prefers Meta's real code over the remapped class code", () => {
    expect(parseMetaCodes(`Meta API Error 368: Too many calls${tail(4)}`)).toEqual({ code: 4, subcode: undefined });
    expect(parseMetaCodes(`x${tail(190, 463)}`)).toEqual({ code: 190, subcode: 463 });
  });

  it("reads Meta's other formats", () => {
    expect(parseMetaCodes("(#10) Application does not have permission")).toEqual({ code: 10, subcode: undefined });
    expect(parseMetaCodes('{"code":100,"error_subcode":2534014}')).toEqual({ code: 100, subcode: 2534014 });
    expect(parseMetaCodes("no codes here")).toEqual({ code: undefined, subcode: undefined });
  });
});

describe("explainError — Meta 190", () => {
  it.each([
    [463, "IG_TOKEN_EXPIRED"],
    [458, "IG_APP_REMOVED"],
    [459, "IG_ACCOUNT_CHECKPOINT"],
    [460, "IG_PASSWORD_CHANGED"],
    [464, "IG_ACCOUNT_UNCONFIRMED"],
    [467, "IG_TOKEN_INVALID"],
  ])("subcode %i → %s, critical, reconnect", (sub, code) => {
    const result = explainError(new TokenExpiredError(`Error validating access token${tail(190, sub)}`));
    expect(result).toMatchObject({ code, severity: "critical", retryable: false, action: { kind: "reconnect", href: "/api/instagram/connect?return=/developer/foundation" } });
  });

  it("uses a live MetaApiError's own subcode", () => {
    expect(explainError(new MetaApiError(190, 463, "t", "Error validating access token")).code).toBe("IG_TOKEN_EXPIRED");
  });

  it("never puts OAuthException / #190 in the user-facing text (TZ §5)", () => {
    const result = explainError(`OAuthException #190: Error validating access token: Session has expired${tail(190, 463)}`);
    expect(result.code).toBe("IG_TOKEN_EXPIRED");
    expect(result.problem).toBe("Instagram ulanishi tugagan.");
    for (const field of [result.problem, result.cause, result.solution, result.action.label]) {
      expect(field).not.toMatch(/OAuthException|#190|code=/);
    }
    expect(result.technical).toContain("OAuthException");
  });

  it("generic 190 without a reason → invalid token", () => {
    expect(explainError(`Error validating access token${tail(190)}`).code).toBe("IG_TOKEN_INVALID");
  });
});

describe("explainError — other Meta codes", () => {
  it.each([4, 17, 32, 613])("rate limit code %i → retryable warning", (code) => {
    const result = explainError(`Meta API Error 368: Application request limit reached${tail(code)}`);
    expect(result).toMatchObject({ code: "IG_RATE_LIMIT", severity: "warning", retryable: true, action: { kind: "wait" } });
  });

  it("RateLimitError without a tail is still a rate limit", () => {
    expect(explainError(new RateLimitError("Too many")).code).toBe("IG_RATE_LIMIT");
  });

  it.each([10, 200, 230])("permission code %i → reconnect", (code) => {
    const result = explainError(new PermissionError(`Permission denied${tail(code)}`));
    expect(result).toMatchObject({ code: "IG_PERMISSION", severity: "error", retryable: false, action: { kind: "reconnect" } });
  });

  it("a real 100 is an invalid parameter, not a permission problem", () => {
    expect(explainError(new PermissionError(`Invalid parameter${tail(100)}`)).code).toBe("IG_INVALID_PARAMETER");
    expect(explainError("Meta API Error 100: Invalid parameter").code).toBe("IG_INVALID_PARAMETER");
    expect(explainError(new PermissionError("bare")).code).toBe("IG_PERMISSION");
  });

  it("551 → user unavailable (info)", () => {
    expect(explainError(new MetaApiError(551, undefined, "t", "This person isn't available right now"))).toMatchObject({
      code: "IG_USER_UNAVAILABLE",
      severity: "info",
      retryable: false,
    });
  });

  it("2534022 window closed and 2534014 user not found", () => {
    expect(explainError(`Meta API Error 100: This message is sent outside of allowed window${tail(100, 2534022)}`).code).toBe(
      "IG_WINDOW_CLOSED"
    );
    expect(explainError(new MetaApiError(100, 2534014, "t", "x")).code).toBe("IG_USER_NOT_FOUND");
    expect(explainError("The requested user cannot be found").code).toBe("IG_USER_NOT_FOUND");
  });

  it.each([1, 2, 503])("code %i → temporary, retryable", (code) => {
    expect(explainError(new MetaApiError(code, undefined, "t", `Please retry${tail(code)}`))).toMatchObject({
      code: "IG_TEMPORARY",
      retryable: true,
    });
  });

  it("unknown Meta code → temporary (Meta may accept it later)", () => {
    expect(explainError(new MetaApiError(9999, undefined, "t", "odd")).code).toBe("IG_TEMPORARY");
  });
});

describe("explainError — non-Meta failures", () => {
  it.each(["fetch failed", "connect ECONNRESET 1.2.3.4", "getaddrinfo ENOTFOUND graph.instagram.com", "Request timed out"])(
    "network: %s",
    (message) => {
      expect(explainError(new Error(message))).toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    }
  );

  it("AbortError → network", () => {
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    expect(explainError(error).code).toBe("NETWORK_ERROR");
  });

  it.each([
    ["Disconnected by user", "IG_DISCONNECTED"],
    ["No Instagram access token available", "IG_DISCONNECTED"],
    ["App removed in Instagram (Meta deauthorize callback)", "IG_APP_REMOVED"],
    ["Failed to decrypt Instagram access token", "IG_TOKEN_UNREADABLE"],
    ["Hourly Instagram DM rate limit reached", "APP_HOURLY_DM_LIMIT"],
    ["Hourly rate limit hit; retry scheduled", "APP_HOURLY_DM_LIMIT"],
    ["Monthly DM limit reached (500)", "PLAN_LIMIT"],
    ["Workspace suspended by platform admin", "WORKSPACE_SUSPENDED"],
    ["Another campaign (X) already sent the one private reply Instagram allows for this comment", "IG_PRIVATE_REPLY_USED"],
    ["Webhook signature cannot be verified: missing secret", "WEBHOOK_SIGNATURE"],
  ])("stored string %s → %s", (text, code) => {
    expect(explainError(text).code).toBe(code);
  });

  it("unknown fallback keeps the raw text only as technical detail", () => {
    const result = explainError(new Error("Kaboom 42"));
    expect(result).toMatchObject({ code: "UNKNOWN", severity: "error", retryable: false });
    expect(result.problem).not.toContain("Kaboom");
    expect(result.technical).toBe("Error: Kaboom 42");
  });

  it("handles empty / odd input", () => {
    expect(explainError(null)).toMatchObject({ code: "UNKNOWN", technical: "—" });
    expect(explainError({ weird: true }).technical).toBe('{"weird":true}');
  });

  it("carries timestamp and related object (TZ §5.1)", () => {
    const result = explainError("fetch failed", {
      timestamp: new Date("2026-10-15T10:00:00Z"),
      related: { type: "DmLog", id: "d1", label: "Kampaniya" },
    });
    expect(result.timestamp).toBe("2026-10-15T10:00:00.000Z");
    expect(result.related).toEqual({ type: "DmLog", id: "d1", label: "Kampaniya" });
    expect(explainError("x", { timestamp: "not a date" }).timestamp).toBeUndefined();
  });

  it("every catalog entry has Uzbek problem / cause / solution and an action", () => {
    for (const entry of Object.values(ERROR_CATALOG)) {
      expect(entry.problem.length).toBeGreaterThan(5);
      expect(entry.cause.length).toBeGreaterThan(5);
      expect(entry.solution.length).toBeGreaterThan(5);
      expect(entry.action.label.length).toBeGreaterThan(0);
    }
  });
});

describe("loadErrorFeed — tenant isolation", () => {
  const T0 = new Date("2026-10-15T12:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.dmLog.findMany.mockResolvedValue([
      {
        id: "d1",
        errorMessage: `Meta API Error 190: Session has expired${tail(190, 463)}`,
        updatedAt: new Date("2026-10-15T11:00:00Z"),
        automation: { name: "Narx" },
        instagramAccount: { username: "shop" },
      },
    ]);
    prisma.webhookEvent.findMany.mockResolvedValue([
      { id: "w1", object: "instagram", errorMessage: "fetch failed", createdAt: new Date("2026-10-15T11:30:00Z") },
    ]);
    prisma.operationalEvent.findMany.mockResolvedValue([
      { id: "o1", source: "TOKEN_REFRESH", message: "Token refresh failed", createdAt: new Date("2026-10-15T09:00:00Z"), resolvedAt: null },
      { id: "o2", source: "SYSTEM", message: "old", createdAt: new Date("2026-10-15T08:00:00Z"), resolvedAt: new Date() },
    ]);
    prisma.instagramEvent.findMany.mockResolvedValue([
      { id: "e1", eventType: "STORY_REPLY", error: "Yuborilmadi", errorDetail: "TokenExpiredError code=190: x [code=190 sub=460]", updatedAt: new Date("2026-10-15T10:00:00Z") },
    ]);
  });

  it("scopes every source by workspaceId and never asks for null-workspace rows", async () => {
    await loadErrorFeed("ws_1", T0);
    for (const model of [prisma.dmLog, prisma.webhookEvent, prisma.operationalEvent, prisma.instagramEvent]) {
      const where = model.findMany.mock.calls[0][0].where;
      expect(where.workspaceId).toBe("ws_1");
      expect(JSON.stringify(where)).not.toMatch(/"OR"|null/);
    }
  });

  it("explains, merges newest-first and drops resolved system events", async () => {
    const feed = await loadErrorFeed("ws_1", T0);
    expect(feed.map((i) => i.id)).toEqual(["webhook:w1", "dm:d1", "trigger:e1", "system:o1"]);
    expect(feed[1]).toMatchObject({ code: "IG_TOKEN_EXPIRED", source: "dm", related: { label: "Narx · @shop" } });
    expect(feed[2].code).toBe("IG_PASSWORD_CHANGED");
    expect(feed[0].code).toBe("NETWORK_ERROR");
  });
});
