import { afterEach, describe, expect, it, vi } from "vitest";
import { FACEBOOK_CLASSIC_SCOPES, facebookAuthorizeUrl, facebookPagesFromCode } from "@/lib/channels/facebook";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers each Graph path in order of the OAuth flow. */
function stubGraph(accounts: unknown[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("/oauth/access_token")) return json({ access_token: "user-token" });
      if (url.pathname.endsWith("/me/accounts")) return json({ data: accounts });
      if (url.pathname.endsWith("/debug_token")) return json({ data: { granular_scopes: [{ scope: "pages_show_list", target_ids: ["111"] }, { scope: "business_management", target_ids: ["999"] }] } });
      if (url.pathname.endsWith("/111")) {
        // Like Meta: the Page node has no `tasks` field.
        if (url.searchParams.get("fields")?.split(",").includes("tasks")) return json({ error: { message: "(#100) Tried accessing nonexisting field (tasks)", code: 100 } }, 400);
        return json({ id: "111", name: "Javob-AI", access_token: "page-token" });
      }
      return json({});
    })
  );
  return calls;
}

describe("facebookPagesFromCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("falls back to the granted Pages when me/accounts is empty (Login for Business)", async () => {
    vi.stubEnv("FACEBOOK_CHANNELS_APP_ID", "app");
    vi.stubEnv("FACEBOOK_CHANNELS_APP_SECRET", "secret");
    const calls = stubGraph([]);
    const pages = await facebookPagesFromCode("code", "https://x/cb");
    expect(pages).toEqual([{ id: "111", name: "Javob-AI", accessToken: "page-token", tasks: [] }]);
    expect(calls.some((c) => c.endsWith("/debug_token"))).toBe(true);
  });

  it("does not call debug_token when me/accounts already lists Pages", async () => {
    vi.stubEnv("FACEBOOK_CHANNELS_APP_ID", "app");
    vi.stubEnv("FACEBOOK_CHANNELS_APP_SECRET", "secret");
    const calls = stubGraph([{ id: "7", name: "Listed", access_token: "t", tasks: ["MANAGE"] }]);
    const pages = await facebookPagesFromCode("code", "https://x/cb");
    expect(pages.map((p) => p.id)).toEqual(["7"]);
    expect(calls.some((c) => c.endsWith("/debug_token"))).toBe(false);
  });

  it("asks with the short token when the long-lived one lists nothing, and re-reads the Page with the long one", async () => {
    vi.stubEnv("FACEBOOK_CHANNELS_APP_ID", "app");
    vi.stubEnv("FACEBOOK_CHANNELS_APP_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        const token = url.searchParams.get("access_token");
        if (url.pathname.endsWith("/oauth/access_token")) return json({ access_token: url.searchParams.get("grant_type") === "fb_exchange_token" ? "long-token" : "short-token" });
        if (url.pathname.endsWith("/me/accounts")) return json({ data: token === "short-token" ? [{ id: "7", name: "Listed", access_token: "page-from-short", tasks: ["MANAGE"] }] : [] });
        if (url.pathname.endsWith("/debug_token")) return json({ data: { granular_scopes: [] } });
        if (url.pathname.endsWith("/7")) return json({ id: "7", name: "Listed", access_token: "page-from-long" });
        return json({});
      })
    );
    const pages = await facebookPagesFromCode("code", "https://x/cb");
    expect(pages).toEqual([{ id: "7", name: "Listed", accessToken: "page-from-long", tasks: [] }]);
  });

  it("classic login asks for the scopes directly and ignores the Login for Business config", () => {
    vi.stubEnv("FACEBOOK_CHANNELS_APP_ID", "app");
    vi.stubEnv("FACEBOOK_LOGIN_CONFIG_ID", "cfg");
    const configured = new URL(facebookAuthorizeUrl("https://x/cb", "s"));
    expect(configured.searchParams.get("config_id")).toBe("cfg");
    const classic = new URL(facebookAuthorizeUrl("https://x/cb", "s", { classic: true }));
    expect(classic.searchParams.get("config_id")).toBeNull();
    expect(classic.searchParams.get("scope")).toBe(FACEBOOK_CLASSIC_SCOPES.join(","));
    expect(classic.searchParams.get("scope")).not.toContain("read_insights");
  });
});
