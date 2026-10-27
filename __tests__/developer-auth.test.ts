import { randomBytes, scryptSync } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeveloperToken,
  isDeveloperAreaConfigured,
  readDeveloperToken,
  verifyDeveloperCredentials,
} from "../lib/developer/auth";
import { DEVELOPER_MODULES, navigableModules } from "../lib/developer/modules";

function hash(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}

const PASSWORD_HASH = hash("correct horse");

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret");
  vi.stubEnv("DEVELOPER_EMAIL", "Dev@Example.com");
  vi.stubEnv("DEVELOPER_PASSWORD_HASH", PASSWORD_HASH);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("developer credentials", () => {
  it("accepts the configured email (any case) and password", () => {
    expect(verifyDeveloperCredentials(" dev@example.com ", "correct horse")).toBe(true);
  });

  it("rejects a wrong password or a different email", () => {
    expect(verifyDeveloperCredentials("dev@example.com", "wrong")).toBe(false);
    expect(verifyDeveloperCredentials("other@example.com", "correct horse")).toBe(false);
  });

  it("stays closed when the area is not configured", () => {
    vi.stubEnv("DEVELOPER_PASSWORD_HASH", "");
    expect(isDeveloperAreaConfigured()).toBe(false);
    expect(verifyDeveloperCredentials("dev@example.com", "correct horse")).toBe(false);
    expect(createDeveloperToken()).toBeNull();
  });
});

describe("developer session token", () => {
  it("round-trips a fresh token", () => {
    const token = createDeveloperToken()!;
    expect(readDeveloperToken(token)).toEqual({ email: "dev@example.com" });
  });

  it("rejects a tampered payload or signature", () => {
    const token = createDeveloperToken()!;
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ email: "dev@example.com", exp: Date.now() + 10 ** 9 })
    ).toString("base64url");
    expect(readDeveloperToken(`${forged}.${signature}`)).toBeNull();
    expect(readDeveloperToken(`${payload}.x${signature}`)).toBeNull();
    expect(readDeveloperToken("garbage")).toBeNull();
  });

  it("expires after 12 hours", () => {
    vi.useFakeTimers();
    const token = createDeveloperToken()!;
    vi.advanceTimersByTime(12 * 60 * 60 * 1000 + 1);
    expect(readDeveloperToken(token)).toBeNull();
  });

  it("is invalidated when the developer email changes", () => {
    const token = createDeveloperToken()!;
    vi.stubEnv("DEVELOPER_EMAIL", "someone-else@example.com");
    expect(readDeveloperToken(token)).toBeNull();
  });

  it("does not verify under another secret", () => {
    const token = createDeveloperToken()!;
    vi.stubEnv("NEXTAUTH_SECRET", "rotated");
    expect(readDeveloperToken(token)).toBeNull();
  });
});

describe("developer module registry", () => {
  it("covers every master-plan stage exactly once", () => {
    expect(DEVELOPER_MODULES.map((m) => m.etap).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(new Set(DEVELOPER_MODULES.map((m) => m.key)).size).toBe(DEVELOPER_MODULES.length);
  });

  it("only links modules under /developer, or a promoted one to its main-dashboard page", () => {
    const PROMOTED: Record<string, string> = { "content-scheduler": "/content" };
    for (const m of navigableModules()) {
      if (PROMOTED[m.key]) expect(m.href).toBe(PROMOTED[m.key]);
      else expect(m.href).toMatch(/^\/developer\//);
    }
  });
});
