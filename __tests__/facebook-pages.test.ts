import { afterEach, describe, expect, it, vi } from "vitest";
import { facebookPagesFromCode } from "@/lib/channels/facebook";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

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
      if (url.pathname.endsWith("/111")) return json({ id: "111", name: "Javob-AI", access_token: "page-token", tasks: ["MANAGE"] });
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
    expect(pages).toEqual([{ id: "111", name: "Javob-AI", accessToken: "page-token", tasks: ["MANAGE"] }]);
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
});
