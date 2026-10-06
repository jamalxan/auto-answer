import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/integrations/throttle", () => ({ acquireSlot: vi.fn(async () => {}) }));

import {
  BitrixClient,
  bitrixLeadUrl,
  isValidBitrixWebhookUrl,
  normalizeWebhookUrl,
} from "../lib/integrations/bitrix24";
import { IntegrationAuthError, IntegrationRequestError } from "../lib/integrations/errors";

const WEBHOOK = "https://promtchi.bitrix24.uz/rest/1/abc123def456/";
const input = {
  title: "Instagram: Aziz — burchakli kulrang divan",
  name: "Aziz",
  phoneE164: "+998901234567",
  igUsername: "aziz_ig",
  sourceDescription: "SocialAuto · Kampaniya: Divan aksiyasi · NARX",
  comments: "Mijoz divan qidiryapti",
};

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];

function respond(handler: (call: Call) => { status?: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        method: new URL(url).pathname.split("/").pop()!.replace(".json", ""),
        body: init.body ? JSON.parse(init.body as string) : {},
      };
      calls.push(call);
      const { status = 200, body } = handler(call);
      return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
    })
  );
}

const client = (config = { assignedById: 1, sourceId: "OTHER" }) => new BitrixClient(WEBHOOK, config, "t");

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Bitrix24 webhook url", () => {
  it("validates the shape", () => {
    expect(isValidBitrixWebhookUrl(WEBHOOK)).toBe(true);
    expect(isValidBitrixWebhookUrl("https://x.bitrix24.ru/rest/12/abcDEF123")).toBe(true);
    expect(isValidBitrixWebhookUrl("http://x.bitrix24.ru/rest/1/abc/")).toBe(false);
    expect(isValidBitrixWebhookUrl("https://x.bitrix24.ru/rest/abc/")).toBe(false);
    expect(isValidBitrixWebhookUrl("javascript:alert(1)")).toBe(false);
  });
  it("normalizes a missing trailing slash", () => {
    expect(normalizeWebhookUrl("https://a.b/rest/1/c")).toBe("https://a.b/rest/1/c/");
  });
  it("builds the lead url from the portal origin", () => {
    expect(bitrixLeadUrl(WEBHOOK, 77)).toBe("https://promtchi.bitrix24.uz/crm/lead/details/77/");
  });
});

describe("crm.lead.add payload (snapshot)", () => {
  it("matches the TZ 7.3 structure", () => {
    expect(client().buildLeadFields(input)).toEqual({
      fields: {
        TITLE: "Instagram: Aziz — burchakli kulrang divan",
        NAME: "Aziz",
        PHONE: [{ VALUE: "+998901234567", VALUE_TYPE: "WORK" }],
        IM: [{ VALUE: "aziz_ig", VALUE_TYPE: "INSTAGRAM" }],
        SOURCE_ID: "OTHER",
        SOURCE_DESCRIPTION: "SocialAuto · Kampaniya: Divan aksiyasi · NARX",
        ASSIGNED_BY_ID: 1,
        COMMENTS: "Mijoz divan qidiryapti",
        OPENED: "Y",
      },
      params: { REGISTER_SONET_EVENT: "Y" },
    });
  });
  it("omits PHONE for a lead without a number", () => {
    expect(client().buildLeadFields({ ...input, phoneE164: null }).fields).not.toHaveProperty("PHONE");
  });
  it("defaults the source to OTHER", () => {
    expect(client({} as never).buildLeadFields(input).fields.SOURCE_ID).toBe("OTHER");
  });
});

describe("Bitrix24 delivery flow", () => {
  it("creates a lead and a timeline comment when no duplicate exists", async () => {
    respond((call) => {
      if (call.method === "crm.duplicate.findbycomm") return { body: { result: [] } };
      if (call.method === "crm.lead.add") return { body: { result: 321 } };
      return { body: { result: 1 } };
    });
    const result = await client().deliverLead(input, "TRANSCRIPT");
    expect(result).toEqual({ leadId: 321, url: "https://promtchi.bitrix24.uz/crm/lead/details/321/", mode: "created" });
    expect(calls.map((c) => c.method)).toEqual(["crm.duplicate.findbycomm", "crm.lead.add", "crm.timeline.comment.add"]);
    expect(calls[0].body).toEqual({ type: "PHONE", values: ["+998901234567"], entity_type: "LEAD" });
    expect(calls[2].body).toEqual({ fields: { ENTITY_ID: 321, ENTITY_TYPE: "lead", COMMENT: "TRANSCRIPT" } });
  });

  it("comments on an open duplicate instead of creating a lead (acceptance #11)", async () => {
    respond((call) => {
      if (call.method === "crm.duplicate.findbycomm") return { body: { result: { LEAD: [55] } } };
      if (call.method === "crm.lead.get") return { body: { result: { STATUS_SEMANTIC_ID: "P" } } };
      return { body: { result: 1 } };
    });
    const result = await client().deliverLead(input, "N");
    expect(result.mode).toBe("comment_on_existing");
    expect(result.leadId).toBe(55);
    expect(calls.some((c) => c.method === "crm.lead.add")).toBe(false);
  });

  it("ignores a closed duplicate (won / lost) and creates a new lead", async () => {
    respond((call) => {
      if (call.method === "crm.duplicate.findbycomm") return { body: { result: { LEAD: [55, 56] } } };
      if (call.method === "crm.lead.get") return { body: { result: { STATUS_SEMANTIC_ID: call.body.id === 55 ? "S" : "F" } } };
      if (call.method === "crm.lead.add") return { body: { result: 900 } };
      return { body: { result: 1 } };
    });
    expect((await client().deliverLead(input, "N")).mode).toBe("created");
  });

  it("retries crm.lead.add with IM type OTHER when INSTAGRAM is rejected", async () => {
    respond((call) => {
      if (call.method === "crm.duplicate.findbycomm") return { body: { result: [] } };
      if (call.method === "crm.lead.add") {
        const im = (call.body.fields as { IM: Array<{ VALUE_TYPE: string }> }).IM[0];
        return im.VALUE_TYPE === "INSTAGRAM"
          ? { status: 400, body: { error: "ERROR_CORE", error_description: "Invalid IM VALUE_TYPE" } }
          : { body: { result: 12 } };
      }
      return { body: { result: 1 } };
    });
    const result = await client().deliverLead(input, "N");
    expect(result.leadId).toBe(12);
    expect(calls.filter((c) => c.method === "crm.lead.add")).toHaveLength(2);
  });
});

describe("Bitrix24 errors", () => {
  it("auth failures break the integration", async () => {
    for (const reply of [{ status: 401 }, { status: 200, body: { error: "INVALID_CREDENTIALS" } }, { status: 200, body: { error: "insufficient_scope" } }]) {
      respond(() => reply);
      await expect(client().checkConnection()).rejects.toBeInstanceOf(IntegrationAuthError);
    }
  });

  it("QUERY_LIMIT_EXCEEDED waits one second and retries", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    respond(() => (++attempt === 1 ? { status: 503, body: { error: "QUERY_LIMIT_EXCEEDED" } } : { body: { result: {} } }));
    const pending = client().checkConnection();
    await vi.advanceTimersByTimeAsync(1100);
    await expect(pending).resolves.toEqual({});
    expect(attempt).toBe(2);
  });

  it("other API errors are retryable request errors", async () => {
    respond(() => ({ status: 500, body: { error: "INTERNAL_SERVER_ERROR" } }));
    await expect(client().checkConnection()).rejects.toBeInstanceOf(IntegrationRequestError);
  });
});
