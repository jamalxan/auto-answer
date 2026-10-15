import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createOAuthState,
  decryptToken,
  encryptToken,
  safeOAuthReturnPath,
  verifyOAuthState,
} from "../lib/meta/oauth";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
});

describe("OAuth state and token encryption", () => {
  it("round-trips encrypted tokens", () => {
    const encrypted = encryptToken("long-lived-token");
    expect(encrypted).not.toBe("long-lived-token");
    expect(decryptToken(encrypted)).toBe("long-lived-token");
  });

  it("signs and verifies Instagram OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(state)?.workspaceId).toBe("workspace_123");
  });

  it("rejects tampered OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(`${state}tampered`)).toBeNull();
  });

  it("carries a developer-area return path through the state", () => {
    const state = createOAuthState("workspace_123", "/developer/foundation");
    expect(verifyOAuthState(state)?.returnTo).toBe("/developer/foundation");
  });

  it("drops return paths outside the developer area (no open redirect)", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/developer/../settings",
      "/developerx",
      "/dashboard",
      "/developer/foundation?x=1",
      "/developer\evil",
    ]) {
      expect(safeOAuthReturnPath(bad)).toBeUndefined();
      expect(verifyOAuthState(createOAuthState("w", bad))?.returnTo).toBeUndefined();
    }
    expect(safeOAuthReturnPath("/developer")).toBe("/developer");
  });
});
