import { describe, expect, it } from "vitest";
import {
  getCampaignTemplate,
  getCampaignTemplates,
  getCampaignTemplateSlugs,
} from "../lib/templates/campaign-templates";

describe("campaign templates", () => {
  it("ships the public launch template set", () => {
    expect(getCampaignTemplateSlugs()).toEqual([
      "dtc-product-link",
      "real-estate-lead-form",
      "fitness-plan",
      "course-webinar",
      "beauty-price-list",
      "restaurant-menu",
      "event-rsvp",
      "creator-media-kit",
    ]);
  });

  it.each(["en", "ru", "uz"] as const)(
    "defines complete clone data for every template (%s)",
    (locale) => {
      for (const template of getCampaignTemplates(locale)) {
        expect(template.title).toBeTruthy();
        expect(template.goal).toBeTruthy();
        expect(template.keywords.length).toBeGreaterThanOrEqual(3);
        expect(template.dmMessage).toContain("{username}");
        expect(template.playbook.length).toBeGreaterThanOrEqual(4);
      }
    }
  );

  it("finds templates by slug and returns null for unknown slugs", () => {
    expect(getCampaignTemplate("dtc-product-link", "en")?.title).toBe(
      "DTC Product Link Drop"
    );
    expect(getCampaignTemplate("missing-template", "en")).toBeNull();
    expect(getCampaignTemplate(undefined, "en")).toBeNull();
  });
});
