import type { MetadataRoute } from "next";

const BASE_URL = (process.env.NEXTAUTH_URL ?? "https://socialauto.uz").replace(/\/$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Signed-in app, platform admin, API and tracked redirect links.
      disallow: [
        "/api/",
        "/admin",
        "/dashboard",
        "/automations",
        "/logs",
        "/settings",
        "/assistant",
        "/leads",
        "/integrations",
        "/r/",
        "/reports/",
        "/invite/",
        "/webhooks/",
      ],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
