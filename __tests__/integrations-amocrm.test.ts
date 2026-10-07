import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/integrations/throttle", () => ({ acquireSlot: vi.fn(async () => {}) }));

import { AmoClient, LongLivedTokenStrategy, renderLeadName, type AmoConfig } from "../lib/integrations/amocrm";
import { IntegrationAuthError, IntegrationRequestError } from "../lib/integrations/errors";

const config: AmoConfig = {
  subdomain: "promtchi",
  zone: "amocrm.ru",
  pipelineId: 123,
  statusId: 456,
  responsibleUserId: 789,
  campaignTag: true,
  leadNameTemplate: "Instagram: {name} — {product_interest}",
};

const input = {
  name: "Instagram: Aziz — burchakli kulrang divan",
  phoneE164: "+998901234567",
  contactName: "Aziz",
  igUsername: "aziz_ig",
  campaignName: "Divan aksiyasi",
};

type Call = { method: string; url: string; body: unknown; auth: string | null };
let calls: Call[] = [];

function respond(handler: (call: Call) => { status?: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        method: init.method ?? "GET",
        url,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        auth: (init.headers as Record<string, string>)?.Authorization ?? null,
      };
      calls.push(call);
      const { status = 200, body } = handler(call);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body ?? ""),
      } as Response;
    })
  );
}

const client = () => new AmoClient(config, new LongLivedTokenStrategy("secret-token-1234567890"), "t");

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("amoCRM complex lead payload", () => {
  it("matches the TZ 7.2 structure (snapshot)", () => {
    expect(client().buildComplexPayload(input)).toEqual([
      {
        name: "Instagram: Aziz — burchakli kulrang divan",
        pipeline_id: 123,
        status_id: 456,
        responsible_user_id: 789,
        _embedded: {
          tags: [{ name: "instagram" }, { name: "socialauto" }, { name: "Divan aksiyasi" }],
          contacts: [
            {
              first_name: "Aziz",
              custom_fields_values: [
                { field_code: "PHONE", values: [{ enum_code: "WORK", value: "+998901234567" }] },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("omits PHONE for a lead without a number", () => {
    const [lead] = client().buildComplexPayload({ ...input, phoneE164: null });
    const contact = (lead._embedded as { contacts: Array<Record<string, unknown>> }).contacts[0];
    expect(contact.custom_fields_values).toBeUndefined();
  });

  it("puts the instagram username into the chosen custom field", () => {
    const withField = new AmoClient({ ...config, igUsernameFieldId: 42 }, new LongLivedTokenStrategy("x".repeat(20)), "t");
    const [lead] = withField.buildComplexPayload(input);
    const contact = (lead._embedded as { contacts: Array<{ custom_fields_values: unknown[] }> }).contacts[0];
    expect(contact.custom_fields_values).toContainEqual({ field_id: 42, values: [{ value: "@aziz_ig" }] });
  });
});

describe("amoCRM delivery flow", () => {
  it("creates a new contact (name + phone) and a new lead, then adds the note", async () => {
    respond((call) =>
      call.url.endsWith("/leads/complex")
        ? { body: [{ id: 9001, contact_id: 5, merged: false }] }
        : { body: [{ id: 1 }] }
    );
    const result = await client().deliverLead(input, "DETAILS");

    expect(result).toEqual({ leadId: 9001, url: "https://promtchi.amocrm.ru/leads/detail/9001", mode: "created" });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/v4/leads/complex",
      "POST /api/v4/leads/9001/notes",
    ]);
    const contact = (calls[0].body as Array<{ _embedded: { contacts: unknown[] } }>)[0]._embedded.contacts[0];
    expect(contact).toEqual({
      first_name: "Aziz",
      custom_fields_values: [
        { field_code: "PHONE", values: [{ enum_code: "WORK", value: "+998901234567" }] },
      ],
    });
    expect(calls[1].body).toEqual([{ note_type: "common", params: { text: "DETAILS" } }]);
    expect(calls.every((c) => c.auth === "Bearer secret-token-1234567890")).toBe(true);
  });

  it("creates a separate lead every time, even for a phone number seen before", async () => {
    let nextId = 100;
    respond((call) => (call.url.endsWith("/leads/complex") ? { body: [{ id: ++nextId }] } : { body: [{ id: 1 }] }));
    const first = await client().deliverLead(input, "A");
    const second = await client().deliverLead(input, "B");

    expect([first.leadId, second.leadId]).toEqual([101, 102]);
    expect(calls.filter((c) => c.url.endsWith("/leads/complex"))).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("/contacts"))).toBe(false);
  });
});

describe("amoCRM errors", () => {
  it("401 and 403 are auth errors (integration becomes broken)", async () => {
    for (const status of [401, 403]) {
      respond(() => ({ status }));
      await expect(client().checkConnection()).rejects.toBeInstanceOf(IntegrationAuthError);
    }
  });

  it("5xx is a retryable request error", async () => {
    respond(() => ({ status: 500, body: { title: "boom" } }));
    await expect(client().checkConnection()).rejects.toBeInstanceOf(IntegrationRequestError);
  });

  it("429 waits and retries", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    respond(() => (++attempt === 1 ? { status: 429 } : { body: { id: 1, name: "x", subdomain: "promtchi" } }));
    const pending = client().checkConnection();
    await vi.advanceTimersByTimeAsync(2100);
    await expect(pending).resolves.toMatchObject({ id: 1 });
    expect(attempt).toBe(2);
    vi.useRealTimers();
  });
});

describe("renderLeadName", () => {
  it("fills the template", () => {
    expect(renderLeadName(undefined, { name: "Aziz", product_interest: "divan", username: "a" })).toBe("Instagram: Aziz — divan");
  });
  it("drops a dangling separator when there is no interest", () => {
    expect(renderLeadName(undefined, { name: "Aziz", product_interest: null, username: null })).toBe("Instagram: Aziz");
  });
  it("caps at 255 characters", () => {
    expect(renderLeadName("{name}", { name: "x".repeat(400), product_interest: null, username: null })).toHaveLength(255);
  });
});
