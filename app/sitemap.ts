import type { MetadataRoute } from "next";
import { getCampaignTemplateSlugs } from "@/lib/templates/campaign-templates";

const BASE_URL = (process.env.NEXTAUTH_URL ?? "https://socialauto.uz").replace(/\/$/, "");

const STATIC_PATHS = [
  "/",
  "/templates",
  "/manychat-alternative",
  "/comment-link-automation",
  "/instagram-comment-to-dm-templates",
  "/instagram-dm-automation-agencies",
  "/privacy",
  "/terms",
  "/data-deletion",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const templatePaths = getCampaignTemplateSlugs().map((slug) => `/templates/${slug}`);
  return [...STATIC_PATHS, ...templatePaths].map((path) => ({
    url: `${BASE_URL}${path}`,
    changeFrequency: "weekly",
    priority: path === "/" ? 1 : 0.6,
  }));
}
