/**
 * ETAP 13 — publish scope detection and the content permission matrix
 * (spec FR-A1): OPERATOR creates, MANAGER+ schedules, VIEWER only looks.
 */
import { describe, expect, it, vi } from "vitest";
import { canContent, canPublishFromScopes, PUBLISH_SCOPE } from "@/lib/content/permissions";
import { exchangeCodeForToken, getAuthorizationUrl } from "@/lib/meta/oauth";

describe("publish scope", () => {
  it("is requested at connect time", () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "app1");
    const url = new URL(getAuthorizationUrl("https://x/cb", "state"));
    expect(url.searchParams.get("scope")!.split(",")).toContain("instagram_business_content_publish");
    vi.unstubAllEnvs();
  });

  it("canPublishFromScopes needs the publish scope", () => {
    expect(canPublishFromScopes(["instagram_business_basic"])).toBe(false);
    expect(canPublishFromScopes(["instagram_business_basic", PUBLISH_SCOPE])).toBe(true);
  });

  it("token exchange returns the granted permissions", async () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "app1");
    vi.stubEnv("INSTAGRAM_APP_SECRET", "s3cret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: "t", user_id: 42, permissions: ["instagram_business_basic", PUBLISH_SCOPE] }))
      )
    );
    const result = await exchangeCodeForToken("code", "https://x/cb");
    expect(result.permissions).toEqual(["instagram_business_basic", PUBLISH_SCOPE]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("token exchange tolerates a comma string or a missing permissions field", async () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "app1");
    vi.stubEnv("INSTAGRAM_APP_SECRET", "s3cret");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "t", user_id: 1, permissions: "a,b" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "t", user_id: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    expect((await exchangeCodeForToken("c", "u")).permissions).toEqual(["a", "b"]);
    expect((await exchangeCodeForToken("c", "u")).permissions).toEqual([]);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("content permissions", () => {
  it("OPERATOR creates but does not schedule", () => {
    expect(canContent("OPERATOR", "content.create")).toBe(true);
    expect(canContent("OPERATOR", "content.schedule")).toBe(false);
    expect(canContent("MEMBER", "content.create")).toBe(true);
  });
  it("MANAGER and above schedule and approve", () => {
    expect(canContent("MANAGER", "content.schedule")).toBe(true);
    expect(canContent("ADMIN", "content.approve")).toBe(true);
    expect(canContent("OWNER", "content.approve")).toBe(true);
  });
  it("VIEWER and unknown roles only view", () => {
    expect(canContent("VIEWER", "content.view")).toBe(true);
    expect(canContent("VIEWER", "content.create")).toBe(false);
    expect(canContent(null, "content.create")).toBe(false);
  });
});
