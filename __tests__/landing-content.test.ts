import { describe, expect, it } from "vitest";
import { LANDING } from "@/lib/landing/content";
import { locales } from "@/lib/i18n/config";
import { getCampaignTemplateSlugs } from "@/lib/templates/campaign-templates";
import robots from "@/app/robots";

const PUBLIC_PAGES = ["/instagram-dm-automation-agencies", "/manychat-alternative"];

describe("landing copy", () => {
  it("has the same shape in every language", () => {
    const uz = LANDING.uz;
    for (const locale of locales) {
      const copy = LANDING[locale];
      expect(copy.modules).toHaveLength(uz.modules.length);
      expect(copy.useCases).toHaveLength(uz.useCases.length);
      expect(copy.proof).toHaveLength(uz.proof.length);
      expect(copy.compareRows).toHaveLength(uz.compareRows.length);
      expect(copy.faqs).toHaveLength(uz.faqs.length);
      expect(copy.trustExtra).toHaveLength(uz.trustExtra.length);
      expect(Object.keys(copy.networks).sort()).toEqual(["facebook", "instagram", "telegram", "threads", "youtube"]);
      // Same icons in the same order, so the grid reads the same in every language.
      expect(copy.modules.map((m) => m.icon)).toEqual(uz.modules.map((m) => m.icon));
      expect(copy.proof.map((p) => p.value)).toEqual(uz.proof.map((p) => p.value));
    }
  });

  it("links every use case to a real template or public page", () => {
    const templates = new Set(getCampaignTemplateSlugs().map((slug) => `/templates/${slug}`));
    for (const locale of locales) {
      for (const useCase of LANDING[locale].useCases) {
        expect(templates.has(useCase.href) || PUBLIC_PAGES.includes(useCase.href), `${locale}: ${useCase.href}`).toBe(true);
      }
    }
  });

  it("states no fabricated proof: no ratings, customer counts or percentages", () => {
    const text = JSON.stringify(LANDING);
    expect(text).not.toMatch(/\d+\s?%|★|rating|reyting|рейтинг|mijozlarimiz|клиентов уже|customers trust/i);
  });
});

describe("robots", () => {
  it("keeps every signed-in area closed and names the answer-engine crawlers", () => {
    const rules = robots().rules;
    const list = Array.isArray(rules) ? rules : [rules];
    for (const rule of list) {
      for (const path of ["/dashboard", "/campaigns", "/content", "/crm", "/billing", "/api/", "/r/", "/reports/"]) {
        expect(rule.disallow).toContain(path);
      }
    }
    const bots = list.flatMap((rule) => (Array.isArray(rule.userAgent) ? rule.userAgent : [rule.userAgent]));
    expect(bots).toEqual(expect.arrayContaining(["*", "GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"]));
  });
});
