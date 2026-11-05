/**
 * JSON-LD for the landing page: one @graph with the organisation, the site,
 * the application (with the real pricing plans as offers) and the FAQ, so
 * search engines and answer engines read the same facts the page shows.
 *
 * Nothing here is invented: no ratings, reviews or download counts. Offers
 * come from the pricing plans the admin publishes.
 */

import type { Locale } from "@/lib/i18n/config";
import type { PricingPlan } from "@/lib/pricing";

export interface HomeJsonLdInput {
  locale: Locale;
  /** Absolute origin, no trailing slash. */
  baseUrl: string;
  /** The page's localized description. */
  description: string;
  plans: PricingPlan[];
  faqs: Array<{ question: string; answer: string }>;
}

type Node = Record<string, unknown> & { "@type": string };

export interface HomeJsonLd {
  "@context": "https://schema.org";
  "@graph": Node[];
}

const LANGUAGE: Record<Locale, string> = { uz: "uz", ru: "ru", en: "en" };

/** Plan currency symbols → ISO 4217 codes for schema.org. */
function currencyCode(symbol: string): string {
  const s = symbol.trim().toLowerCase();
  if (s === "$" || s === "usd") return "USD";
  if (s === "€" || s === "eur") return "EUR";
  if (s === "₽" || s === "rub") return "RUB";
  if (s === "so'm" || s === "сум" || s === "uzs" || s === "сўм") return "UZS";
  return symbol.toUpperCase();
}

export function buildHomeJsonLd(input: HomeJsonLdInput): HomeJsonLd {
  const { locale, baseUrl, description, plans, faqs } = input;
  const organizationId = `${baseUrl}/#organization`;
  const websiteId = `${baseUrl}/#website`;

  const organization: Node = {
    "@type": "Organization",
    "@id": organizationId,
    name: "SocialAuto",
    url: baseUrl,
    logo: `${baseUrl}/icon-512.png`,
  };

  const website: Node = {
    "@type": "WebSite",
    "@id": websiteId,
    name: "SocialAuto",
    url: baseUrl,
    inLanguage: LANGUAGE[locale],
    publisher: { "@id": organizationId },
  };

  const application: Node = {
    "@type": "SoftwareApplication",
    "@id": `${baseUrl}/#app`,
    name: "SocialAuto",
    url: baseUrl,
    description,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    inLanguage: LANGUAGE[locale],
    publisher: { "@id": organizationId },
  };
  if (plans.length > 0) {
    application.offers = plans.map((plan) => ({
      "@type": "Offer",
      name: plan.content[locale]?.name || plan.slug,
      description: plan.content[locale]?.description || undefined,
      price: String(plan.priceAmount),
      priceCurrency: currencyCode(plan.priceCurrency),
      url: `${baseUrl}/#pricing`,
      availability: "https://schema.org/InStock",
    }));
  }

  const graph: Node[] = [organization, website, application];

  if (faqs.length > 0) {
    graph.push({
      "@type": "FAQPage",
      "@id": `${baseUrl}/#faq`,
      inLanguage: LANGUAGE[locale],
      mainEntity: faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer },
      })),
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

/**
 * JSON for a <script type="application/ld+json">. `<` becomes < so no
 * string in the graph (an FAQ answer edited later, a plan name) can close
 * the script element; JSON.parse gives the original text back.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
