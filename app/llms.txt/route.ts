import { getCampaignTemplateSlugs } from "@/lib/templates/campaign-templates";
import { getActivePricingPlans, getDefaultPricingPlans } from "@/lib/pricing";
import { buildLlmsText } from "@/lib/seo/llms";

const BASE_URL = (process.env.NEXTAUTH_URL ?? "https://socialauto.uz").replace(/\/$/, "");

/** Plain-text brief for AI crawlers (llms.txt convention). Same facts as the landing page. */
export async function GET() {
  const plans = await getActivePricingPlans().catch(() => getDefaultPricingPlans());
  const text = buildLlmsText({ baseUrl: BASE_URL, plans, templateSlugs: getCampaignTemplateSlugs() });
  return new Response(text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
