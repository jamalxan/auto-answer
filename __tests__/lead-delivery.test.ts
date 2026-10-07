import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("REDIS_URL", "redis://localhost:6379");

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/integrations/throttle", () => ({ acquireSlot: vi.fn(async () => {}) }));
vi.mock("../lib/queue/assistant-queue", () => ({
  enqueueDelivery: vi.fn(async () => {}),
  enqueueNotify: vi.fn(async () => {}),
  scheduleReply: vi.fn(async () => {}),
}));
vi.mock("../lib/telegram/notify", () => ({
  alertWorkspace: vi.fn(async () => {}),
  sendWithRetry: vi.fn(async () => ({ message_id: 11 })),
  notifyWorkspaceChats: vi.fn(async () => 1),
}));
vi.mock("../lib/telegram/api", async (original) => ({
  ...(await original<typeof import("../lib/telegram/api")>()),
  editMessageReplyMarkup: vi.fn(async () => ({})),
}));

import {
  enqueueLeadDeliveries,
  integrationAcceptsAccount,
  processDelivery,
  redeliverLead,
  refreshLeadStatus,
  resumeIntegration,
  sweepDueDeliveries,
} from "../lib/leads/delivery";
import { encryptCredentials } from "../lib/integrations/crypto";
import { MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_MS, nextRetryDelayMs } from "../lib/integrations/errors";
import { enqueueDelivery } from "../lib/queue/assistant-queue";
import { alertWorkspace, sendWithRetry } from "../lib/telegram/notify";
import { editMessageReplyMarkup } from "../lib/telegram/api";
import { db, resetDb } from "./helpers/db-instance";

const TOKEN = "t".repeat(40);

function mockCrm(handler: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const { status = 200, body } = handler(url, init);
      return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => "" } as Response;
    })
  );
}

const amoOk = (url: string) =>
  url.endsWith("/leads/complex") ? { body: [{ id: 9001 }] } : { body: [{ id: 1 }] };

function seedBase() {
  const ws = db.seed("workspace", { id: "w1" });
  const account = db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "jamalxann", instagramId: "ig1" });
  const lead = db.seed("lead", {
    id: "l1", workspaceId: "w1", instagramAccountId: account.id, conversationId: null, idempotencyKey: "c1:0",
    igUserId: "u1", igUsername: "aziz_ig", name: "Aziz", phoneE164: "+998901234567",
    productInterest: "divan", transcript: "TRANSCRIPT", summary: "Divan qidiryapti",
  });
  const telegram = db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
  db.seed("telegramChat", { integrationId: telegram.id, chatId: "-100", title: "Sotuv" });
  const amo = db.seed("integration", {
    id: "int_amo", workspaceId: "w1", type: "AMOCRM", name: "amoCRM",
    credentialsEncrypted: encryptCredentials({ token: TOKEN }),
    config: { subdomain: "promtchi", zone: "amocrm.ru" },
  });
  return { ws, account, lead, telegram, amo };
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  vi.mocked(sendWithRetry).mockResolvedValue({ message_id: 11 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("retry schedule", () => {
  it("is 30s, 2m, 10m, 1h, 6h then dead (TZ section 7)", () => {
    expect(RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000, 3_600_000, 21_600_000]);
    expect(nextRetryDelayMs(1)).toBe(30_000);
    expect(nextRetryDelayMs(2)).toBe(120_000);
    expect(nextRetryDelayMs(5 - 1)).toBe(3_600_000);
    expect(nextRetryDelayMs(MAX_DELIVERY_ATTEMPTS)).toBeNull();
  });
});

describe("enqueueLeadDeliveries", () => {
  it("creates one pending delivery per active integration and queues it", async () => {
    const { lead } = seedBase();
    await enqueueLeadDeliveries(lead as never, "new");
    expect(db.rows("leadDelivery")).toHaveLength(2);
    expect(enqueueDelivery).toHaveBeenCalledTimes(2);
  });

  it("is idempotent", async () => {
    const { lead } = seedBase();
    await enqueueLeadDeliveries(lead as never, "new");
    await enqueueLeadDeliveries(lead as never, "new");
    expect(db.rows("leadDelivery")).toHaveLength(2);
  });

  it("holds deliveries of a BROKEN integration without queueing a job", async () => {
    const { lead, amo } = seedBase();
    amo.status = "BROKEN";
    await enqueueLeadDeliveries(lead as never, "new");
    expect(db.rows("leadDelivery")).toHaveLength(2);
    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    const held = db.rows("leadDelivery").find((d) => d.integrationId === "int_amo")!;
    expect(held.status).toBe("PENDING");
    expect(held.nextAttemptAt).toBeNull();
  });

  it("skips disabled integrations and honours the Instagram account filter", async () => {
    const { lead, amo } = seedBase();
    amo.igAccountFilter = ["other-account"];
    await enqueueLeadDeliveries(lead as never, "new");
    expect(db.rows("leadDelivery").map((d) => d.integrationId)).toEqual(["int_tg"]);
    expect(integrationAcceptsAccount({ igAccountFilter: [] }, "x")).toBe(true);
    expect(integrationAcceptsAccount({ igAccountFilter: ["a1"] }, "a1")).toBe(true);
    expect(integrationAcceptsAccount({ igAccountFilter: ["a1"] }, "a2")).toBe(false);

    amo.igAccountFilter = [];
    amo.status = "DISABLED";
    db.tables.leadDelivery = [];
    await enqueueLeadDeliveries(lead as never, "new");
    expect(db.rows("leadDelivery")).toHaveLength(1);
  });
});

describe("processDelivery — Telegram", () => {
  it("sends to every active chat, stores message refs, marks the lead SENT", async () => {
    const { lead, telegram } = seedBase();
    db.tables.integration = db.rows("integration").filter((i) => i.id === telegram.id);
    const d = db.seed("leadDelivery", { leadId: lead.id, integrationId: telegram.id, nextAttemptAt: new Date() });

    await processDelivery(d.id as string);

    expect(sendWithRetry).toHaveBeenCalledTimes(1);
    const text = vi.mocked(sendWithRetry).mock.calls[0][1] as string;
    expect(text).toContain("Yangi lid");
    expect(text).toContain("+998901234567");
    expect(text).toContain("@jamalxann");
    expect(d.status).toBe("SENT");
    expect(JSON.parse(d.externalId as string)).toEqual([{ chatId: "-100", messageId: 11 }]);
    expect(lead.status).toBe("SENT");
  });

  it("a Telegram failure retries with backoff and finally goes DEAD with an alert", async () => {
    const { lead, telegram } = seedBase();
    db.tables.integration = db.rows("integration").filter((i) => i.id === telegram.id);
    const d = db.seed("leadDelivery", { leadId: lead.id, integrationId: telegram.id });
    vi.mocked(sendWithRetry).mockRejectedValue(new Error("chat not found"));

    for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      d.nextAttemptAt = new Date(Date.now() - 1000); // the scheduled retry fires
      await processDelivery(d.id as string);
      if (attempt < MAX_DELIVERY_ATTEMPTS) {
        expect(d.status).toBe("FAILED");
        expect(d.attempts).toBe(attempt);
        const delay = (d.nextAttemptAt as Date).getTime() - Date.now();
        expect(Math.abs(delay - RETRY_DELAYS_MS[attempt - 1])).toBeLessThan(2000);
        expect(enqueueDelivery).toHaveBeenLastCalledWith(d.id, RETRY_DELAYS_MS[attempt - 1]);
      }
    }
    expect(d.status).toBe("DEAD");
    expect(d.attempts).toBe(5);
    expect(alertWorkspace).toHaveBeenCalledTimes(1);
    expect(lead.status).toBe("FAILED");
    expect(d.lastError).toContain("chat not found");
  });
});

describe("delivery lease", () => {
  it("two concurrent workers send a delivery only once", async () => {
    const { lead, telegram } = seedBase();
    db.tables.integration = db.rows("integration").filter((i) => i.id === telegram.id);
    const d = db.seed("leadDelivery", { leadId: lead.id, integrationId: telegram.id, nextAttemptAt: new Date() });
    await Promise.all([processDelivery(d.id as string), processDelivery(d.id as string)]);
    expect(sendWithRetry).toHaveBeenCalledTimes(1);
    expect(d.status).toBe("SENT");
  });

  it("an attempt scheduled in the future is not run early by the sweeper or a stray job", async () => {
    const { lead, telegram } = seedBase();
    db.tables.integration = db.rows("integration").filter((i) => i.id === telegram.id);
    const d = db.seed("leadDelivery", { leadId: lead.id, integrationId: telegram.id, status: "FAILED", nextAttemptAt: new Date(Date.now() + 60_000) });
    await processDelivery(d.id as string);
    expect(sendWithRetry).not.toHaveBeenCalled();
  });
});

describe("processDelivery — amoCRM", () => {
  it("delivers the lead, stores the CRM link and adds it to the Telegram message buttons", async () => {
    const { lead, telegram, amo } = seedBase();
    mockCrm(amoOk);
    const tg = db.seed("leadDelivery", { leadId: lead.id, integrationId: telegram.id, status: "SENT", externalId: JSON.stringify([{ chatId: "-100", messageId: 11 }]) });
    const d = db.seed("leadDelivery", { leadId: lead.id, integrationId: amo.id });

    await processDelivery(d.id as string);

    expect(d.status).toBe("SENT");
    expect(d.externalId).toBe("9001");
    expect(d.externalUrl).toBe("https://promtchi.amocrm.ru/leads/detail/9001");
    expect(tg.status).toBe("SENT");
    expect(editMessageReplyMarkup).toHaveBeenCalledTimes(1);
    const keyboard = vi.mocked(editMessageReplyMarkup).mock.calls[0][2];
    expect(JSON.stringify(keyboard)).toContain("https://promtchi.amocrm.ru/leads/detail/9001");
    expect(lead.status).toBe("SENT");
  });

  it("creates the contact from the customer's name and phone and notes everything they told us", async () => {
    const { lead, amo } = seedBase();
    const requests: Array<{ url: string; body: string }> = [];
    mockCrm((url, init) => {
      requests.push({ url, body: String(init.body ?? "") });
      return amoOk(url);
    });
    const d = db.seed("leadDelivery", { leadId: lead.id, integrationId: amo.id });

    await processDelivery(d.id as string);

    expect(d.status).toBe("SENT");
    const complex = JSON.parse(requests.find((r) => r.url.endsWith("/leads/complex"))!.body);
    expect(complex[0]._embedded.contacts[0]).toMatchObject({
      first_name: "Aziz",
      custom_fields_values: [{ field_code: "PHONE", values: [{ value: "+998901234567" }] }],
    });
    const note = JSON.parse(requests.find((r) => r.url.endsWith("/notes"))!.body)[0].params.text;
    expect(note).toContain("Ism: Aziz");
    expect(note).toContain("Telefon: +998901234567");
    expect(note).toContain("Qiziqish: divan");
    expect(note).toContain("Xulosa: Divan qidiryapti");
    expect(note).toContain("TRANSCRIPT");
  });

  it("an invalid token breaks the integration, keeps the lead, and Telegram still gets it (acceptance #10)", async () => {
    const { lead, telegram, amo } = seedBase();
    mockCrm(() => ({ status: 401 }));
    await enqueueLeadDeliveries(lead as never, "new");
    const tgDelivery = db.rows("leadDelivery").find((d) => d.integrationId === telegram.id)!;
    const amoDelivery = db.rows("leadDelivery").find((d) => d.integrationId === amo.id)!;

    await processDelivery(tgDelivery.id as string);
    await processDelivery(amoDelivery.id as string);

    expect(tgDelivery.status).toBe("SENT");
    expect(amo.status).toBe("BROKEN");
    expect(amo.lastError).toContain("401");
    expect(amoDelivery.status).toBe("PENDING"); // held, not burned through retries
    expect(amoDelivery.attempts).toBe(0);
    expect(alertWorkspace).toHaveBeenCalled();
    expect(lead.status).toBe("PARTIAL");

    // A later lead while broken: Telegram gets it, amoCRM is held.
    const second = db.seed("lead", { id: "l2", workspaceId: "w1", instagramAccountId: "a1", idempotencyKey: "c2:0", igUserId: "u2", name: "Ali", phoneE164: "+998931112233", transcript: "T2" });
    await enqueueLeadDeliveries(second as never, "new");
    const held = db.rows("leadDelivery").find((d) => d.leadId === "l2" && d.integrationId === amo.id)!;
    expect(held.nextAttemptAt).toBeNull();

    // Token repaired: held deliveries are released and delivered automatically.
    mockCrm(amoOk);
    amo.status = "ACTIVE";
    vi.mocked(enqueueDelivery).mockClear();
    const released = await resumeIntegration(amo.id as string);
    expect(released).toBe(2);
    await processDelivery(amoDelivery.id as string);
    await processDelivery(held.id as string);
    expect(amoDelivery.status).toBe("SENT");
    expect(held.status).toBe("SENT");
    expect(lead.status).toBe("SENT");
  });

  it("an integration error never affects another integration", async () => {
    const { lead, telegram, amo } = seedBase();
    mockCrm(() => ({ status: 500, body: {} }));
    const tg = db.seed("leadDelivery", { leadId: lead.id, integrationId: telegram.id });
    const amoDelivery = db.seed("leadDelivery", { leadId: lead.id, integrationId: amo.id });
    await processDelivery(amoDelivery.id as string);
    await processDelivery(tg.id as string);
    expect(amoDelivery.status).toBe("FAILED");
    expect(tg.status).toBe("SENT");
    expect(amo.status).toBe("ACTIVE");
  });

  it("a held delivery of a disabled integration is not sent", async () => {
    const { lead, amo } = seedBase();
    amo.status = "DISABLED";
    mockCrm(amoOk);
    const d = db.seed("leadDelivery", { leadId: lead.id, integrationId: amo.id, nextAttemptAt: new Date() });
    await processDelivery(d.id as string);
    expect(d.status).toBe("PENDING");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("repeat inquiries (TZ 7.4)", () => {
  it("adds a note to the ORIGINAL CRM lead instead of creating a new one", async () => {
    const { lead, amo } = seedBase();
    db.seed("leadDelivery", { leadId: lead.id, integrationId: amo.id, status: "SENT", kind: "new", externalId: "9001" });
    const repeat = db.seed("lead", {
      id: "l2", workspaceId: "w1", instagramAccountId: "a1", idempotencyKey: "c2:0", igUserId: "u1", name: "Aziz",
      phoneE164: "+998901234567", isRepeat: true, repeatOfId: lead.id, transcript: "SECOND TRANSCRIPT",
    });
    const d = db.seed("leadDelivery", { leadId: repeat.id, integrationId: amo.id, kind: "repeat" });
    const requests: Array<{ url: string; body: string }> = [];
    mockCrm((url, init) => {
      requests.push({ url, body: String(init.body ?? "") });
      return { body: [{ id: 1 }] };
    });

    await processDelivery(d.id as string);

    expect(d.status).toBe("SENT");
    expect(d.externalId).toBe("9001");
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("/api/v4/leads/9001/notes");
    expect(requests[0].body).toContain("Takroriy murojaat");
    expect(requests[0].body).toContain("SECOND TRANSCRIPT");
  });

  it("Telegram shows the repeat marker", async () => {
    const { lead, telegram } = seedBase();
    const repeat = db.seed("lead", { id: "l2", workspaceId: "w1", instagramAccountId: "a1", idempotencyKey: "c2:0", igUserId: "u1", name: "Aziz", phoneE164: "+998901234567", isRepeat: true, repeatOfId: lead.id });
    const d = db.seed("leadDelivery", { leadId: repeat.id, integrationId: telegram.id, kind: "repeat" });
    await processDelivery(d.id as string);
    expect(vi.mocked(sendWithRetry).mock.calls[0][1]).toContain("Takroriy murojaat");
    expect(vi.mocked(sendWithRetry).mock.calls[0][1]).toContain("🔁");
  });
});

describe("recovery helpers", () => {
  it("sweepDueDeliveries re-queues stale due deliveries of active integrations only", async () => {
    const { lead, telegram, amo } = seedBase();
    amo.status = "BROKEN";
    db.seed("leadDelivery", { leadId: lead.id, integrationId: telegram.id, nextAttemptAt: new Date(Date.now() - 5 * 60_000) });
    db.seed("leadDelivery", { leadId: lead.id, integrationId: amo.id, nextAttemptAt: new Date(Date.now() - 5 * 60_000) });
    db.seed("leadDelivery", { leadId: "l9", integrationId: telegram.id, nextAttemptAt: new Date(Date.now() + 60_000) });
    expect(await sweepDueDeliveries()).toBe(1);
  });

  it("redeliverLead resets dead deliveries of active integrations", async () => {
    const { lead, telegram, amo } = seedBase();
    amo.status = "BROKEN";
    const dead = db.seed("leadDelivery", { leadId: lead.id, integrationId: telegram.id, status: "DEAD", attempts: 5 });
    db.seed("leadDelivery", { leadId: lead.id, integrationId: amo.id, status: "DEAD", attempts: 5 });
    expect(await redeliverLead(lead.id as string)).toBe(1);
    expect(dead.status).toBe("PENDING");
    expect(dead.attempts).toBe(0);
  });

  it("refreshLeadStatus: all sent / partial / failed", async () => {
    const { lead } = seedBase();
    const a = db.seed("leadDelivery", { leadId: lead.id, integrationId: "x1", status: "SENT" });
    const b = db.seed("leadDelivery", { leadId: lead.id, integrationId: "x2", status: "DEAD" });
    await refreshLeadStatus(lead.id as string);
    expect(lead.status).toBe("PARTIAL");
    a.status = "DEAD";
    await refreshLeadStatus(lead.id as string);
    expect(lead.status).toBe("FAILED");
    a.status = "SENT";
    b.status = "SENT";
    await refreshLeadStatus(lead.id as string);
    expect(lead.status).toBe("SENT");
  });
});
