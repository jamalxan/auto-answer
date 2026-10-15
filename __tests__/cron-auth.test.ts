import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

function req(authorization?: string) {
  return new Request("http://localhost/api/cron/x", {
    headers: authorization ? { authorization } : {},
  });
}

describe("isAuthorizedCronRequest", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the configured bearer secret", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCronRequest(req("Bearer s3cret"))).toBe(true);
  });

  it("rejects a wrong or missing header", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCronRequest(req("Bearer nope"))).toBe(false);
    expect(isAuthorizedCronRequest(req())).toBe(false);
  });

  it("refuses everything when no secret is configured", () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(isAuthorizedCronRequest(req("Bearer undefined"))).toBe(false);
    expect(isAuthorizedCronRequest(req("Bearer "))).toBe(false);
  });
});
