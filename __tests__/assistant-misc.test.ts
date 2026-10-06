import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("NEXTAUTH_URL", "https://socialauto.uz");

const queue = vi.hoisted(() => {
  const jobs = new Map<string, { id: string; state: string; data: unknown; opts: Record<string, unknown>; removed?: boolean; remove: () => Promise<void>; getState: () => Promise<string> }>();
  return {
    jobs,
    add: vi.fn(async (name: string, data: unknown, opts: Record<string, unknown>) => {
      const id = String(opts.jobId);
      const job = { id, state: "delayed", data, opts, remove: async () => void jobs.delete(id), getState: async () => job.state };
      jobs.set(id, job);
      return job;
    }),
    getJob: vi.fn(async (id: string) => jobs.get(id)),
  };
});

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.add = queue.add;
    this.getJob = queue.getJob;
    return this;
  }),
}));
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/telegram/notify", () => ({
  alertWorkspace: vi.fn(async () => {}),
  sendWithRetry: vi.fn(),
  notifyWorkspaceChats: vi.fn(),
}));

import { enqueueDelivery, scheduleReply } from "../lib/queue/assistant-queue";
import { parseAssistantInbound, parseEchoEvents } from "../lib/meta/webhook";
import { buildLeadWhere, leadsToCsv } from "../lib/leads/query";
import { TRANSCRIPT_MAX_CHARS, buildLeadHeader, buildTranscript } from "../lib/leads/transcript";
import { buildLeadKeyboard, buildLeadText, leadMarker } from "../lib/telegram/lead-message";
import { expiryWarningDue } from "../lib/integrations/service";
import { maskPhone, maskSecret, decryptCredentials, encryptCredentials } from "../lib/integrations/crypto";
import { assertPublicUrl, AutofillError, htmlToText, isPrivateAddress } from "../lib/assistant/autofill";
import { markTokenBroken, markTokenHealthy } from "../lib/meta/token-health";
import { alertWorkspace } from "../lib/telegram/notify";
import { runTokenExpiryWarnings } from "../lib/integrations/expiry";
import { db, resetDb } from "./helpers/db-instance";

beforeEach(() => {
  queue.jobs.clear();
  vi.clearAllMocks();
  resetDb();
});

describe("debounced reply scheduling (acceptance #3)", () => {
  it("keeps exactly one pending reply job per conversation, re-armed by every message", async () => {
    await scheduleReply("c1", 4000);
    await scheduleReply("c1", 4000);
    await scheduleReply("c1", 4000);
    const pending = [...queue.jobs.values()].filter((j) => j.opts.jobId === "reply_c1");
    expect(pending).toHaveLength(1);
    expect(pending[0].opts.delay).toBe(4000);
    expect(queue.add).toHaveBeenCalledTimes(3);
  });

  it("schedules a fresh job when the previous one is already running", async () => {
    await scheduleReply("c1", 4000);
    queue.jobs.get("reply_c1")!.state = "active";
    await scheduleReply("c1", 4000);
    expect(queue.jobs.size).toBe(2);
    expect(queue.jobs.get("reply_c1")).toBeTruthy(); // the running one is left alone
  });

  it("different conversations do not interfere", async () => {
    await scheduleReply("c1", 4000);
    await scheduleReply("c2", 4000);
    expect(queue.jobs.size).toBe(2);
  });

  it("delivery job ids contain no colon (BullMQ rejects them)", async () => {
    await enqueueDelivery("d1:x", 1000);
    for (const job of queue.jobs.values()) expect(String(job.opts.jobId)).not.toContain(":");
  });
});

describe("webhook parsing for the assistant", () => {
  const payload = (messaging: unknown[]) => ({ object: "instagram", entry: [{ id: "ig1", time: 1, messaging }] }) as never;

  it("extracts text DMs and attachment-only messages", () => {
    const events = parseAssistantInbound(
      payload([
        { sender: { id: "u1" }, recipient: { id: "ig1" }, message: { mid: "m1", text: " salom " } },
        { sender: { id: "u1" }, recipient: { id: "ig1" }, message: { mid: "m2", attachments: [{ type: "image" }] } },
        { sender: { id: "u1" }, recipient: { id: "ig1" }, message: { mid: "m3", is_unsupported: true } },
      ])
    );
    expect(events).toEqual([
      { instagramAccountId: "ig1", senderId: "u1", messageId: "m1", text: "salom", hasAttachment: false },
      { instagramAccountId: "ig1", senderId: "u1", messageId: "m2", text: "", hasAttachment: true },
      { instagramAccountId: "ig1", senderId: "u1", messageId: "m3", text: "", hasAttachment: true },
    ]);
  });

  it("ignores echoes, deletions, empty messages and the account itself", () => {
    expect(
      parseAssistantInbound(
        payload([
          { sender: { id: "ig1" }, recipient: { id: "u1" }, message: { mid: "e1", text: "x", is_echo: true } },
          { sender: { id: "u1" }, recipient: { id: "ig1" }, message: { mid: "d1", text: "x", is_deleted: true } },
          { sender: { id: "u1" }, recipient: { id: "ig1" }, message: { mid: "n1" } },
          { sender: { id: "ig1" }, recipient: { id: "ig1" }, message: { mid: "s1", text: "self" } },
        ])
      )
    ).toEqual([]);
  });

  it("parses echoes with and without an app id", () => {
    expect(
      parseEchoEvents(
        payload([
          { sender: { id: "ig1" }, recipient: { id: "u1" }, message: { mid: "e1", text: "hi", is_echo: true, app_id: 123 } },
          { sender: { id: "ig1" }, recipient: { id: "u2" }, message: { mid: "e2", text: "from the app", is_echo: true } },
          { sender: { id: "u1" }, recipient: { id: "ig1" }, message: { mid: "x", text: "customer" } },
        ])
      )
    ).toEqual([
      { instagramAccountId: "ig1", customerId: "u1", messageId: "e1", text: "hi", appId: "123" },
      { instagramAccountId: "ig1", customerId: "u2", messageId: "e2", text: "from the app", appId: null },
    ]);
  });
});

describe("transcript (TZ 6.3)", () => {
  const lead = {
    name: "Aziz", igUsername: "aziz_ig", phoneE164: "+998901234567", productInterest: "burchakli kulrang divan",
    campaignName: "Divan aksiyasi", triggerKeyword: "NARX", postUrl: "https://instagram.com/p/xxx",
    source: "CAMPAIGN" as const, summary: "Mijoz divan qidiryapti.",
  };

  it("formats the header like the spec", () => {
    expect(buildLeadHeader(lead)).toBe(
      [
        "📥 Instagram lid — SocialAuto",
        "Mijoz: Aziz (@aziz_ig) · +998901234567",
        "Qiziqish: burchakli kulrang divan",
        'Manba: Kampaniya "Divan aksiyasi" · kalit so\'z: NARX · post: https://instagram.com/p/xxx',
        "Xulosa: Mijoz divan qidiryapti.",
      ].join("\n")
    );
  });

  it("labels the author of each line and timestamps it", () => {
    const text = buildTranscript(lead, [
      { author: "CUSTOMER", text: "Salom", createdAt: new Date(2026, 9, 6, 14, 2) },
      { author: "ASSISTANT", text: "Assalomu alaykum!", createdAt: new Date(2026, 9, 6, 14, 2) },
      { author: "OPERATOR", text: "Men operator", createdAt: new Date(2026, 9, 6, 14, 30) },
    ]);
    expect(text).toContain("--- Suhbat ---");
    expect(text).toContain("[06.10 14:02] Mijoz: Salom");
    expect(text).toContain("[06.10 14:02] Assistent: Assalomu alaykum!");
    expect(text).toContain("[06.10 14:30] Operator: Men operator");
  });

  it("an inbound lead says so and an absent phone is explicit", () => {
    const header = buildLeadHeader({ ...lead, source: "INBOUND_DM", phoneE164: null, campaignName: null });
    expect(header).toContain("Instagram DM");
    expect(header).toContain("raqam berilmadi");
  });

  it("truncates from the beginning to 15 000 chars and says so", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ author: "CUSTOMER" as const, text: `xabar ${i} ${"a".repeat(60)}`, createdAt: new Date() }));
    const text = buildTranscript(lead, many);
    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_MAX_CHARS);
    expect(text).toContain("...(oldingi xabarlar qisqartirildi)");
    expect(text).toContain("xabar 599");
    expect(text).not.toContain("xabar 0 ");
    expect(text.startsWith("📥 Instagram lid")).toBe(true);
  });

  it("short conversations are untouched", () => {
    expect(buildTranscript(lead, [{ author: "CUSTOMER", text: "salom", createdAt: new Date() }])).not.toContain("qisqartirildi");
  });
});

describe("Telegram lead message (TZ 7.1)", () => {
  const input = {
    id: "l1", igAccountUsername: "jamalxann", name: "Aziz", igUsername: "aziz_ig", phoneE164: "+998901234567",
    productInterest: "burchakli kulrang divan", extraField: null, source: "CAMPAIGN" as const, campaignName: "Divan aksiyasi",
    triggerKeyword: "NARX", summary: "Mijoz divan qidiryapti.", flag: null, isTest: false, isRepeat: false,
    conversationId: "c1", contactedAt: null,
  };

  it("renders the sample lead", () => {
    expect(buildLeadText(input)).toBe(
      [
        "🟢 <b>Yangi lid</b> — @jamalxann",
        "👤 Aziz (@aziz_ig)",
        "📞 +998901234567",
        "🛋 Qiziqish: burchakli kulrang divan",
        '📍 Manba: Kampaniya "Divan aksiyasi" (NARX)',
        "📝 Mijoz divan qidiryapti.",
      ].join("\n")
    );
  });

  it("uses 🟡 for no phone, 🔴 for a complaint, 🔁 for a repeat", () => {
    expect(leadMarker({ flag: "no_phone", isRepeat: false, isTest: false })).toBe("🟡");
    expect(buildLeadText({ ...input, phoneE164: null, flag: "no_phone" })).toContain("Raqam berilmadi — Instagram'da yozing");
    expect(leadMarker({ flag: "complaint", isRepeat: false, isTest: false })).toBe("🔴");
    expect(leadMarker({ flag: null, isRepeat: true, isTest: false })).toBe("🔁");
    expect(buildLeadText({ ...input, isRepeat: true })).toContain("Takroriy murojaat");
  });

  it("marks tests and escapes HTML from customer-controlled fields", () => {
    const text = buildLeadText({ ...input, isTest: true, name: "<b>x</b>", summary: "a & b <script>" });
    expect(text).toContain("[TEST]");
    expect(text).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(text).toContain("a &amp; b &lt;script&gt;");
    expect(text).not.toContain("<script>");
  });

  it("buttons: inbox, CRM links (added after delivery) and Bog'lanildi", () => {
    const keyboard = buildLeadKeyboard(input, [{ label: "amoCRM", url: "https://x.amocrm.ru/leads/detail/1" }]);
    expect(keyboard[0].map((b) => b.text)).toEqual(["💬 Instagram suhbat", "📋 amoCRM"]);
    expect(keyboard[0][0].url).toBe("https://socialauto.uz/inbox?conversation=c1");
    expect(keyboard[1]).toEqual([{ text: "✅ Bog'lanildi", callback_data: "contacted:l1" }]);
    expect(buildLeadKeyboard({ ...input, contactedAt: new Date() }, []).flat().some((b) => b.callback_data)).toBe(false);
  });
});

describe("leads list filters and CSV", () => {
  it("always scopes by workspace and maps filters", () => {
    const where = buildLeadWhere("w1", { status: "sent", source: "campaign", account: "a1", from: "2026-10-01", to: "2026-10-06", q: "Aziz" });
    expect(where).toMatchObject({ workspaceId: "w1", status: "SENT", source: "CAMPAIGN", instagramAccountId: "a1" });
    expect((where.createdAt as { gte: Date }).gte.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect((where.createdAt as { lte: Date }).lte.toISOString()).toBe("2026-10-06T23:59:59.999Z");
    expect(where.OR).toBeTruthy();
  });

  it("ignores unknown filter values instead of failing", () => {
    const where = buildLeadWhere("w1", { status: "bogus", source: "x", account: "all", from: "nope" });
    expect(where).toEqual({ workspaceId: "w1" });
  });

  it("searches phones by digits", () => {
    const where = buildLeadWhere("w1", { q: "+998 90 123" });
    expect(JSON.stringify(where.OR)).toContain("99890123");
  });

  it("exports CSV with quoting and formula-injection protection", () => {
    const csv = leadsToCsv([
      { createdAt: new Date("2026-10-06T10:00:00Z"), name: '=HYPERLINK("x")', phoneE164: "+998901234567", igUsername: "a", productInterest: "divan, burchakli", source: "CAMPAIGN", campaignName: null, status: "SENT", flag: null, isRepeat: false, summary: 'say "hi"\nnow' },
    ]);
    const [header, row] = csv.split("\n", 2);
    expect(header).toBe("date,name,phone,instagram,interest,source,campaign,status,flag,repeat,summary");
    expect(row).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(row).toContain("+998901234567");
    expect(row).toContain('"divan, burchakli"');
    expect(csv).toContain('"say ""hi""\nnow"');
  });
});

describe("secrets", () => {
  it("masks tokens to the last four characters and phones in logs", () => {
    expect(maskSecret("abcdefgh1234")).toBe("••••1234");
    expect(maskSecret("")).toBe("");
    expect(maskPhone("+998901234567")).toBe("+99890***4567");
    expect(maskPhone(null)).toBe("");
  });

  it("round-trips encrypted credentials and never stores them in clear", () => {
    const encrypted = encryptCredentials({ token: "super-secret-token" });
    expect(encrypted).not.toContain("super-secret");
    expect(decryptCredentials<{ token: string }>(encrypted).token).toBe("super-secret-token");
    expect(decryptCredentials(null)).toEqual({});
  });
});

describe("amoCRM token expiry warnings (TZ 7.2)", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

  it("warns at 14 days, then at 3 days, once each", () => {
    expect(expiryWarningDue(days(20), null, now)).toBeNull();
    expect(expiryWarningDue(days(13), null, now)).toBe(14);
    expect(expiryWarningDue(days(13), days(-0.5), now)).toBeNull();
    expect(expiryWarningDue(days(2.5), days(-10.5), now)).toBe(3);
    expect(expiryWarningDue(days(2), days(-1), now)).toBeNull();
  });

  it("does not warn for an already expired token", () => {
    expect(expiryWarningDue(days(-1), null, now)).toBeNull();
  });

  it("the runner alerts once and records the warning", async () => {
    db.seed("integration", { id: "i1", workspaceId: "w1", type: "AMOCRM", name: "amoCRM", tokenExpiresAt: days(10) });
    expect(await runTokenExpiryWarnings(now)).toBe(1);
    expect(alertWorkspace).toHaveBeenCalledTimes(1);
    expect(await runTokenExpiryWarnings(now)).toBe(0);
  });
});

describe("website autofill safety (TZ 3.1)", () => {
  it("rejects private and loopback addresses (SSRF)", async () => {
    for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
    await expect(assertPublicUrl("http://127.0.0.1/admin")).rejects.toMatchObject({ code: "private_address" });
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toBeInstanceOf(AutofillError);
  });

  it("rejects non-http schemes and credentials in the URL", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toMatchObject({ code: "bad_url" });
    await expect(assertPublicUrl("javascript:alert(1)")).rejects.toMatchObject({ code: "bad_url" });
    await expect(assertPublicUrl("https://user:pass@example.com")).rejects.toMatchObject({ code: "bad_url" });
    await expect(assertPublicUrl("not a url")).rejects.toMatchObject({ code: "bad_url" });
  });

  it("accepts a public address", async () => {
    await expect(assertPublicUrl("https://93.184.216.34/")).resolves.toBeInstanceOf(URL);
  });

  it("turns HTML into readable text without scripts and styles", () => {
    expect(htmlToText("<html><style>a{}</style><script>evil()</script><h1>Mebel&nbsp;Plus</h1><p>Divan &amp; kreslo</p></html>")).toBe("Mebel Plus Divan & kreslo");
  });
});

describe("Instagram token health", () => {
  function seedAccount() {
    db.seed("workspace", { id: "w1", ownerId: "o", owner: {} });
    return db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "jamalxann", tokenStatus: "ACTIVE" });
  }

  it("flips an account to BROKEN, records the event and alerts once a day", async () => {
    const account = seedAccount();
    await markTokenBroken("a1", "Error validating access token [code=190]");
    expect(account.tokenStatus).toBe("BROKEN");
    expect(account.tokenLastError).toContain("190");
    expect(account.tokenBrokenAt).toBeInstanceOf(Date);
    expect(db.rows("operationalEvent")).toHaveLength(1);
    expect(alertWorkspace).toHaveBeenCalledTimes(1);

    await markTokenBroken("a1", "still broken");
    expect(alertWorkspace).toHaveBeenCalledTimes(1); // within the 24h cooldown
    expect(db.rows("operationalEvent")).toHaveLength(1);

    account.tokenAlertedAt = new Date(Date.now() - 25 * 3600_000);
    await markTokenBroken("a1", "still broken");
    expect(alertWorkspace).toHaveBeenCalledTimes(2);
  });

  it("clears the broken state after a successful check", async () => {
    const account = seedAccount();
    await markTokenBroken("a1", "x");
    await markTokenHealthy("a1");
    expect(account).toMatchObject({ tokenStatus: "ACTIVE", tokenLastError: null, tokenBrokenAt: null });
  });
});
