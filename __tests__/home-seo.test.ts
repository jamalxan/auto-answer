/** Structured data and the llms.txt text for the landing page (lib/seo). */
import { describe, expect, it } from "vitest";
import { buildHomeJsonLd, serializeJsonLd } from "@/lib/seo/home-structured-data";
import { buildLlmsText } from "@/lib/seo/llms";
import type { PricingPlan } from "@/lib/pricing";

const plan = (over: Partial<PricingPlan>): PricingPlan => ({
  id: "p",
  slug: "starter",
  priceAmount: 0,
  priceCurrency: "$",
  priceSuffix: "/mo",
  isFeatured: false,
  isActive: true,
  sortOrder: 0,
  content: {
    uz: { name: "Start", description: "Bitta akkaunt", features: ["1 akkaunt"] },
    ru: { name: "Старт", description: "Один аккаунт", features: ["1 аккаунт"] },
    en: { name: "Starter", description: "One account", features: ["1 account"] },
  },
  ...over,
});

const faqs = [
  { question: "Parol kerakmi?", answer: "Yo'q, Meta kirishi orqali." },
  { question: "Bloklanmaydimi?", answer: "Rasmiy API <b>orqali</b>." },
];

describe("buildHomeJsonLd", () => {
  it("one graph: organization, website, the app with real offers, and the FAQ", () => {
    const plans = [plan({}), plan({ id: "b", slug: "biznes", priceAmount: 190000, priceCurrency: "so'm", isFeatured: true, content: { uz: { name: "Biznes", description: "Uch akkaunt", features: [] }, ru: { name: "Бизнес", description: "", features: [] }, en: { name: "Business", description: "", features: [] } } })];
    const data = buildHomeJsonLd({ locale: "uz", baseUrl: "https://socialauto.uz", description: "Izoh → DM", plans, faqs });
    const graph = data["@graph"];
    expect(data["@context"]).toBe("https://schema.org");
    expect(graph.map((n) => n["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication", "FAQPage"]);

    const org = graph[0];
    expect(org).toMatchObject({ "@id": "https://socialauto.uz/#organization", name: "SocialAuto", url: "https://socialauto.uz", logo: "https://socialauto.uz/icon-512.png" });

    const app = graph[2];
    expect(app).toMatchObject({ name: "SocialAuto", applicationCategory: "BusinessApplication", operatingSystem: "Web", inLanguage: "uz", url: "https://socialauto.uz" });
    expect(app.offers).toEqual([
      expect.objectContaining({ "@type": "Offer", name: "Start", price: "0", priceCurrency: "USD" }),
      expect.objectContaining({ "@type": "Offer", name: "Biznes", price: "190000", priceCurrency: "UZS" }),
    ]);

    const faq = graph[3] as unknown as { mainEntity: unknown[] };
    expect(faq.mainEntity).toHaveLength(2);
    expect(faq.mainEntity[0]).toEqual({ "@type": "Question", name: "Parol kerakmi?", acceptedAnswer: { "@type": "Answer", text: "Yo'q, Meta kirishi orqali." } });
  });

  it("speaks the page's language and skips the FAQ node when there are no questions", () => {
    const data = buildHomeJsonLd({ locale: "ru", baseUrl: "https://socialauto.uz", description: "x", plans: [], faqs: [] });
    expect(data["@graph"].map((n) => n["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication"]);
    expect(data["@graph"][2]).toMatchObject({ inLanguage: "ru" });
    expect(data["@graph"][2]).not.toHaveProperty("offers");
  });

  it("serializes with < escaped so a crafted FAQ answer cannot close the script tag", () => {
    const data = buildHomeJsonLd({ locale: "en", baseUrl: "https://socialauto.uz", description: "x", plans: [], faqs: [{ question: "q", answer: "</script><img src=x>" }] });
    const text = serializeJsonLd(data);
    expect(text).not.toContain("</script>");
    expect(text.includes("\\u003c/script>")).toBe(true);
    expect(JSON.parse(text)["@graph"][3].mainEntity[0].acceptedAnswer.text).toBe("</script><img src=x>");
  });
});

describe("buildLlmsText", () => {
  it("is a plain-text brief for AI crawlers: name, what it does, networks, modules, plans and links", () => {
    const text = buildLlmsText({ baseUrl: "https://socialauto.uz", plans: [plan({}), plan({ id: "b", slug: "pro", priceAmount: 49 })], templateSlugs: ["course-webinar", "beauty-price-list"] });
    expect(text.startsWith("# SocialAuto")).toBe(true);
    for (const network of ["Instagram", "Facebook", "Threads", "YouTube", "Telegram"]) expect(text).toContain(network);
    expect(text).toContain("- Starter: $0/mo");
    expect(text).toContain("- Starter: $49/mo");
    expect(text).toContain("https://socialauto.uz/templates/course-webinar");
    expect(text).toContain("https://socialauto.uz/manychat-alternative");
    expect(text).not.toContain("undefined");
    // Uzbek, Russian and English are all named so an answer engine knows which to quote.
    expect(text).toMatch(/Uzbek/);
  });
});
