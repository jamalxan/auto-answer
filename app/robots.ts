import type { MetadataRoute } from "next";

const BASE_URL = (process.env.NEXTAUTH_URL ?? "https://socialauto.uz").replace(/\/$/, "");

// Every signed-in area (they redirect to /login anyway), the platform admin,
// the API, tracked redirect links and private client report / invite links.
const DISALLOW = [
  "/api/",
  "/admin",
  "/dashboard",
  "/overview",
  "/campaigns",
  "/content",
  "/channels",
  "/ads",
  "/javobai",
  "/comments",
  "/triggers",
  "/flows",
  "/crm",
  "/engagement",
  "/analytics",
  "/telegram",
  "/connectors",
  "/migration",
  "/billing",
  "/inbox",
  "/diagnostics",
  "/automations",
  "/logs",
  "/settings",
  "/assistant",
  "/leads",
  "/integrations",
  "/developer",
  "/r/",
  "/reports/",
  "/invite/",
  "/review/",
  "/webhooks/",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: DISALLOW },
      // Answer engines are welcome on the public pages (and /llms.txt); the
      // same private areas stay closed to them.
      {
        userAgent: ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-User", "anthropic-ai", "PerplexityBot", "Google-Extended", "Applebot-Extended", "CCBot", "Bingbot"],
        allow: "/",
        disallow: DISALLOW,
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
