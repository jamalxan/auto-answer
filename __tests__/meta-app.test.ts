import { describe, expect, it } from "vitest";
import { facebookChannelsApp } from "@/lib/channels/meta-app";

describe("facebookChannelsApp", () => {
  it("prefers the channels app over the Instagram app", () => {
    const env = { FACEBOOK_APP_ID: "ig", FACEBOOK_APP_SECRET: "ig-secret", FACEBOOK_CHANNELS_APP_ID: " ch ", FACEBOOK_CHANNELS_APP_SECRET: "ch-secret" };
    expect(facebookChannelsApp(env)).toEqual({ appId: "ch", secret: "ch-secret" });
  });

  it("falls back to FACEBOOK_APP_* when the channels app is not configured", () => {
    const env = { FACEBOOK_APP_ID: "ig", FACEBOOK_APP_SECRET: "ig-secret" };
    expect(facebookChannelsApp(env)).toEqual({ appId: "ig", secret: "ig-secret" });
  });

  it("returns empty strings when nothing is set", () => {
    expect(facebookChannelsApp({})).toEqual({ appId: "", secret: "" });
  });
});

describe("metaAppSecrets", () => {
  it("includes the channels and Threads app secrets for deauthorize / data-deletion callbacks", async () => {
    const { metaAppSecrets } = await import("@/lib/meta/signed-request");
    process.env.FACEBOOK_CHANNELS_APP_SECRET = "channels-s";
    process.env.THREADS_APP_SECRET = "threads-s";
    try {
      expect(metaAppSecrets()).toEqual(expect.arrayContaining(["channels-s", "threads-s"]));
    } finally {
      delete process.env.FACEBOOK_CHANNELS_APP_SECRET;
      delete process.env.THREADS_APP_SECRET;
    }
  });
});
