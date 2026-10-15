import { describe, expect, it } from "vitest";

import { parseConfigPatch } from "../lib/integrations/config";

describe("integration config PATCH whitelist", () => {
  it("accepts the settings the UI edits", () => {
    expect(
      parseConfigPatch("AMOCRM", {
        pipelineId: 1,
        statusId: 2,
        responsibleUserId: 3,
        campaignTag: false,
        leadNameTemplate: "{name}",
        igUsernameFieldId: 4,
      })
    ).toEqual({ pipelineId: 1, statusId: 2, responsibleUserId: 3, campaignTag: false, leadNameTemplate: "{name}", igUsernameFieldId: 4 });
    expect(parseConfigPatch("BITRIX24", { assignedById: 7, sourceId: "WEB" })).toEqual({ assignedById: 7, sourceId: "WEB" });
  });

  it("refuses to change where requests (and the token) are sent (SSRF)", () => {
    expect(parseConfigPatch("AMOCRM", { subdomain: "169.254.169.254/x" })).toBeNull();
    expect(parseConfigPatch("AMOCRM", { zone: "internal.local" })).toBeNull();
    expect(parseConfigPatch("AMOCRM", { pipelineId: 1, subdomain: "other" })).toBeNull();
    expect(parseConfigPatch("BITRIX24", { webhookUrl: "https://127.0.0.1/rest/1/a/" })).toBeNull();
    expect(parseConfigPatch("TELEGRAM", { anything: 1 })).toBeNull();
  });

  it("rejects wrongly typed values", () => {
    expect(parseConfigPatch("AMOCRM", { pipelineId: "1" })).toBeNull();
    expect(parseConfigPatch("AMOCRM", { leadNameTemplate: "x".repeat(256) })).toBeNull();
  });
});
