/**
 * Audit phase 7 — ads: guardrails (owner approval, caps, CPL), boost
 * suggestions, the Marketing API build (PAUSED → ACTIVE, rollback), the
 * guard's automatic pauses, Click-to-Direct context and Conversions API —
 * against fixture HTTP, no live keys.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "k".repeat(64));

const redisStore = vi.hoisted(() => new Map<string, string>());
const notify = vi.hoisted(() => vi.fn(async (...args: [string, string, unknown?]) => args.length && 1));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({
  getRedisConnection: () => ({
    set: async (key: string, value: string, ...rest: unknown[]) => {
      if (rest.includes("NX") && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return "OK";
    },
    incr: async (key: string) => {
      const next = Number(redisStore.get(key) ?? 0) + 1;
      redisStore.set(key, String(next));
      return next;
    },
    expire: async () => 1,
  }),
}));
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: notify }));

import { accountStop, checkApproval, cplTooHigh, daysLeftInMonth, isBoostCandidate, type ApprovalInput } from "../lib/ads/guardrails";
import { latestAdReferral, parseAdReferrals, storeAdReferrals } from "../lib/ads/referral";
import {
  AdsError,
  adsOverview,
  approveProposal,
  guardAds,
  queueSaleEvent,
  resumeProposal,
  saveAdAccount,
  sendPendingSaleEvents,
  suggestBoosts,
  updateAdAccount,
} from "../lib/ads/service";
import { buildJavobAiSystemPrompt } from "../lib/javobai/prompt";
import { db, resetDb } from "./helpers/db-instance";

type Route = { method?: string; match: RegExp; reply: (url: string, body: string) => { status?: number; body?: unknown } };
const calls: Array<{ method: string; url: string; body: string }> = [];
let routes: Route[] = [];
const serve = (...next: Route[]) => (routes = next);

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body instanceof URLSearchParams ? init.body.toString() : typeof init.body === "string" ? init.body : "";
    calls.push({ method, url, body });
    const route = routes.find((r) => (!r.method || r.method === method) && r.match.test(url));
    if (!route) return new Response(JSON.stringify({ error: { code: 100, message: `no fixture ${method} ${url}` } }), { status: 400 });
    const out = route.reply(url, body);
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
  })
);

const form = (body: string) => Object.fromEntries(new URLSearchParams(body));
const NOW = new Date("2026-10-27T12:00:00Z");

beforeEach(() => {
  resetDb();
  redisStore.clear();
  calls.length = 0;
  routes = [];
  vi.clearAllMocks();
});

async function seedAccount(overrides: Record<string, unknown> = {}) {
  db.seed("workspace", { id: "w1", ownerId: "owner" });
  db.seed("instagramAccount", { id: "ig1", workspaceId: "w1", instagramId: "1784", username: "shop", accessToken: "x" });
  const account = await saveAdAccount("w1", { adAccountId: "act_9", name: "Do'kon Ads", currency: "USD", token: "ADS_TOKEN" });
  const row = db.rows("adAccount")[0];
  Object.assign(row, { pageId: "page1", igUserId: "1784", dailyCapMinor: 2000, monthlyCapMinor: 30000, cplMaxMinor: 300, ...overrides });
  return account;
}

function seedProposal(overrides: Record<string, unknown> = {}) {
  return db.seed("adProposal", {
    id: "pr1",
    workspaceId: "w1",
    accountId: db.rows("adAccount")[0].id,
    igMediaId: "m1",
    reason: "2.4×",
    dailyBudgetMinor: 500,
    durationDays: 5,
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    ...overrides,
  });
}

// ─── Guardrails (pure) ─────────────────────────────────────────────────────────

describe("guardrails", () => {
  const base: ApprovalInput = {
    role: "OWNER",
    caps: { dailyCapMinor: 2000, monthlyCapMinor: 30000, cplMaxMinor: 300 },
    accountStatus: "ACTIVE",
    offset: 100,
    proposal: { dailyBudgetMinor: 500, durationDays: 5 },
    live: [],
    monthSpentMinor: 0,
    now: NOW,
  };

  it("lets only the owner approve, and only with all three caps set", () => {
    expect(checkApproval(base)).toEqual({ ok: true });
    expect(checkApproval({ ...base, role: "ADMIN" })).toMatchObject({ ok: false, reason: expect.stringContaining("egasi") });
    expect(checkApproval({ ...base, caps: { ...base.caps, cplMaxMinor: null } })).toMatchObject({ ok: false, reason: expect.stringContaining("chegara") });
    expect(checkApproval({ ...base, accountStatus: "ERROR" }).ok).toBe(false);
  });

  it("holds the daily cap together with live campaigns", () => {
    expect(checkApproval({ ...base, live: [{ dailyBudgetMinor: 1500, endAt: null }] }).ok).toBe(true);
    expect(checkApproval({ ...base, live: [{ dailyBudgetMinor: 1600, endAt: null }] })).toMatchObject({ ok: false, reason: expect.stringContaining("Kunlik") });
  });

  it("projects the rest of the month against the monthly cap", () => {
    // 5 days × 5 USD = 25 USD new; 28 000 already spent → 30 500 > 30 000.
    expect(checkApproval({ ...base, monthSpentMinor: 28_000 })).toMatchObject({ ok: false, reason: expect.stringContaining("Oylik") });
    expect(checkApproval({ ...base, monthSpentMinor: 27_500 }).ok).toBe(true);
    expect(daysLeftInMonth(NOW, null)).toBe(5); // Oct 27 12:00 → Nov 1
    expect(daysLeftInMonth(NOW, new Date("2026-10-29T12:00:00Z"))).toBe(2);
  });

  it("rejects silly budgets and durations", () => {
    expect(checkApproval({ ...base, proposal: { dailyBudgetMinor: 50, durationDays: 5 } }).ok).toBe(false);
    expect(checkApproval({ ...base, proposal: { dailyBudgetMinor: 500, durationDays: 31 } }).ok).toBe(false);
    expect(checkApproval({ ...base, proposal: { dailyBudgetMinor: 500, durationDays: 0 } }).ok).toBe(false);
  });

  it("stops on caps and judges CPL only after 2× the limit was spent", () => {
    const caps = base.caps;
    expect(accountStop(caps, 2000, 0)).toBe("daily_cap");
    expect(accountStop(caps, 100, 30_000)).toBe("monthly_cap");
    expect(accountStop(caps, 1999, 29_999)).toBeNull();
    expect(cplTooHigh(300, 500, 0)).toBe(false);
    expect(cplTooHigh(300, 600, 0)).toBe(true);
    expect(cplTooHigh(300, 900, 2)).toBe(true);
    expect(cplTooHigh(300, 900, 3)).toBe(false);
  });

  it("calls a post a boost candidate at 2× the median", () => {
    expect(isBoostCandidate({ score: 2.4, views: 900, publishedAt: new Date(NOW.getTime() - 86_400_000) }, NOW)).toBe(true);
    expect(isBoostCandidate({ score: 1.9, views: 900, publishedAt: NOW }, NOW)).toBe(false);
    expect(isBoostCandidate({ score: 3, views: 100, publishedAt: NOW }, NOW)).toBe(false);
    expect(isBoostCandidate({ score: 3, views: 900, publishedAt: new Date(NOW.getTime() - 20 * 86_400_000) }, NOW)).toBe(false);
  });
});

// ─── Suggestions ───────────────────────────────────────────────────────────────

describe("boost suggestions", () => {
  it("proposes a winning post once and tells the owner that nothing is spent without approval", async () => {
    await seedAccount();
    db.seed("contentPostStat", { id: "s1", workspaceId: "w1", instagramAccountId: "ig1", igMediaId: "m1", mediaType: "VIDEO", permalink: "https://ig/p/1", publishedAt: new Date(NOW.getTime() - 86_400_000), views: 4000, score: 2.5 });
    db.seed("contentPostStat", { id: "s2", workspaceId: "w1", instagramAccountId: "ig1", igMediaId: "m2", mediaType: "VIDEO", publishedAt: NOW, views: 4000, score: 1.2 });
    expect(await suggestBoosts(NOW)).toBe(1);
    expect(await suggestBoosts(NOW)).toBe(0);
    expect(db.rows("adProposal")).toHaveLength(1);
    expect(db.rows("adProposal")[0]).toMatchObject({ igMediaId: "m1", status: "PROPOSED", dailyBudgetMinor: 500, durationDays: 5 });
    expect(notify.mock.calls[0][1]).toContain("tasdiqsiz pul sarflanmaydi");
    expect(calls).toHaveLength(0);
  });
});

// ─── Approval → launch ─────────────────────────────────────────────────────────

describe("approval and launch", () => {
  const graph = () =>
    serve(
      { method: "POST", match: /act_9\/campaigns$/, reply: () => ({ body: { id: "camp1" } }) },
      { method: "POST", match: /act_9\/adsets$/, reply: () => ({ body: { id: "set1" } }) },
      { method: "POST", match: /act_9\/adcreatives$/, reply: () => ({ body: { id: "cr1" } }) },
      { method: "POST", match: /act_9\/ads$/, reply: () => ({ body: { id: "ad1" } }) },
      { method: "POST", match: /\/(camp1|set1|cr1|ad1)$/, reply: () => ({ body: { success: true } }) }
    );

  it("refuses a non-owner before any Meta call", async () => {
    await seedAccount();
    seedProposal();
    await expect(approveProposal({ workspaceId: "w1", proposalId: "pr1", userId: "admin", role: "ADMIN", now: NOW })).rejects.toBeInstanceOf(AdsError);
    expect(calls).toHaveLength(0);
    expect(db.rows("adProposal")[0].status).toBe("PROPOSED");
  });

  it("builds everything PAUSED with an end time, then activates ad → ad set → campaign", async () => {
    await seedAccount();
    seedProposal();
    graph();
    const live = await approveProposal({ workspaceId: "w1", proposalId: "pr1", userId: "owner", role: "OWNER", dailyBudgetMinor: 700, durationDays: 3, now: NOW });
    expect(live).toMatchObject({ status: "LIVE", campaignId: "camp1", adSetId: "set1", adId: "ad1", dailyBudgetMinor: 700, approvedById: "owner" });
    const created = calls.slice(0, 4).map((c) => form(c.body));
    expect(created[0]).toMatchObject({ objective: "OUTCOME_ENGAGEMENT", status: "PAUSED", access_token: "ADS_TOKEN" });
    expect(created[1]).toMatchObject({ daily_budget: "700", status: "PAUSED", optimization_goal: "CONVERSATIONS", destination_type: "INSTAGRAM_DIRECT", end_time: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() });
    expect(created[2]).toMatchObject({ source_instagram_media_id: "m1", instagram_user_id: "1784", object_id: "page1" });
    expect(calls.slice(4).map((c) => [c.url.split("/").pop(), form(c.body).status])).toEqual([
      ["ad1", "ACTIVE"],
      ["set1", "ACTIVE"],
      ["camp1", "ACTIVE"],
    ]);
    await expect(approveProposal({ workspaceId: "w1", proposalId: "pr1", userId: "owner", role: "OWNER", now: NOW })).rejects.toThrow(/ko'rib chiqilgan/);
  });

  it("deletes what was created when a step fails, and never activates", async () => {
    await seedAccount();
    seedProposal();
    graph();
    routes[3] = { method: "POST", match: /act_9\/ads$/, reply: () => ({ status: 400, body: { error: { code: 100, message: "creative rejected" } } }) };
    await expect(approveProposal({ workspaceId: "w1", proposalId: "pr1", userId: "owner", role: "OWNER", now: NOW })).rejects.toThrow(/creative rejected/);
    const after = calls.slice(4).map((c) => [c.url.split("/").pop(), form(c.body).status]);
    expect(after).toEqual([
      ["cr1", "DELETED"],
      ["set1", "DELETED"],
      ["camp1", "DELETED"],
    ]);
    expect(db.rows("adProposal")[0]).toMatchObject({ status: "FAILED" });
  });

  it("refuses when the new budget would break the daily cap", async () => {
    await seedAccount({ dailyCapMinor: 600 });
    seedProposal();
    seedProposal({ id: "pr0", igMediaId: "m0", status: "LIVE", dailyBudgetMinor: 400, endAt: new Date(NOW.getTime() + 86_400_000) });
    await expect(approveProposal({ workspaceId: "w1", proposalId: "pr1", userId: "owner", role: "OWNER", now: NOW })).rejects.toThrow(/Kunlik/);
    expect(calls).toHaveLength(0);
  });

  it("keeps caps owner-only and never shows the token", async () => {
    const account = await seedAccount();
    await expect(updateAdAccount("w1", account.id, { dailyCapMinor: 99999 }, "ADMIN")).rejects.toMatchObject({ status: 403 });
    await updateAdAccount("w1", account.id, { dailyCapMinor: 1000 }, "OWNER");
    const overview = await adsOverview("w1", NOW);
    expect(overview.accounts[0].dailyCapMinor).toBe(1000);
    expect(JSON.stringify(overview)).not.toContain("ADS_TOKEN");
    expect(JSON.stringify(overview)).not.toContain(db.rows("adAccount")[0].encryptedPayload as string);
  });
});

// ─── Guard ─────────────────────────────────────────────────────────────────────

describe("guard", () => {
  const insights = (spend: string, results: number) =>
    serve(
      { match: /camp1\/insights/, reply: () => ({ body: { data: [{ date_start: "2026-10-27", spend, actions: results ? [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: String(results) }] : [] }] } }) },
      { method: "POST", match: /\/camp1$/, reply: () => ({ body: { success: true } }) }
    );

  it("pauses every live campaign at the daily cap and tells the owner", async () => {
    await seedAccount();
    seedProposal({ status: "LIVE", campaignId: "camp1", startAt: new Date(NOW.getTime() - 3600_000), endAt: new Date(NOW.getTime() + 4 * 86_400_000) });
    insights("20.00", 30);
    const summary = await guardAds(NOW);
    expect(summary.paused).toBe(1);
    expect(db.rows("adProposal")[0]).toMatchObject({ status: "PAUSED", pauseReason: "daily_cap", spendMinor: 2000, results: 30 });
    expect(form(calls.find((c) => c.method === "POST")!.body).status).toBe("PAUSED");
    expect(notify.mock.calls[0][1]).toContain("avtomatik to'xtatildi");
  });

  it("pauses a campaign whose leads cost more than the CPL limit", async () => {
    await seedAccount();
    seedProposal({ status: "LIVE", campaignId: "camp1", startAt: NOW, endAt: new Date(NOW.getTime() + 4 * 86_400_000) });
    insights("9.00", 2); // 4.50 per lead > 3.00
    await guardAds(NOW);
    expect(db.rows("adProposal")[0]).toMatchObject({ status: "PAUSED", pauseReason: "cpl" });
  });

  it("leaves a healthy campaign running, finishes ended ones and expires old proposals", async () => {
    await seedAccount();
    seedProposal({ status: "LIVE", campaignId: "camp1", startAt: NOW, endAt: new Date(NOW.getTime() + 4 * 86_400_000) });
    seedProposal({ id: "pr2", igMediaId: "m2", expiresAt: new Date(NOW.getTime() - 1000) });
    insights("6.00", 4);
    const summary = await guardAds(NOW);
    expect(summary).toMatchObject({ paused: 0, expired: 1 });
    expect(db.rows("adProposal").find((p) => p.id === "pr1")!.status).toBe("LIVE");
    expect(db.rows("adProposal").find((p) => p.id === "pr2")!.status).toBe("EXPIRED");

    insights("6.00", 4);
    await guardAds(new Date(NOW.getTime() + 5 * 86_400_000));
    expect(db.rows("adProposal").find((p) => p.id === "pr1")!.status).toBe("DONE");
  });

  it("resumes only with the owner and only under the caps", async () => {
    await seedAccount();
    seedProposal({ status: "PAUSED", pauseReason: "owner", campaignId: "camp1", startAt: NOW, endAt: new Date(NOW.getTime() + 2 * 86_400_000) });
    serve({ method: "POST", match: /\/camp1$/, reply: () => ({ body: { success: true } }) });
    await expect(resumeProposal("w1", "pr1", "ADMIN", NOW)).rejects.toMatchObject({ status: 422 });
    expect(calls).toHaveLength(0);
    await expect(resumeProposal("w1", "pr1", "OWNER", NOW)).resolves.toMatchObject({ status: "LIVE" });
    expect(form(calls[0].body).status).toBe("ACTIVE");
  });
});

// ─── Click-to-Direct + CAPI ────────────────────────────────────────────────────

describe("Click-to-Direct context", () => {
  const payload = {
    object: "instagram",
    entry: [
      {
        id: "1784",
        messaging: [
          { sender: { id: "cust1" }, message: { mid: "m1", text: "Narxi?", referral: { ad_id: "ad77", source: "ADS", type: "OPEN_THREAD", ads_context_data: { ad_title: "Qishki kurtka -20%", post_id: "p9" } } } },
          { sender: { id: "1784" }, message: { mid: "m2", is_echo: true, referral: { ad_id: "ad77" } } },
        ],
      },
    ],
  };

  it("stores the ad a thread came from and gives its title to the model as data", async () => {
    db.seed("instagramAccount", { id: "ig1", workspaceId: "w1", instagramId: "1784", username: "shop", accessToken: "x" });
    expect(parseAdReferrals(payload)).toHaveLength(1);
    expect(await storeAdReferrals(payload)).toBe(1);
    expect(await storeAdReferrals(payload)).toBe(0);
    const ref = await latestAdReferral("ig1", "cust1");
    expect(ref).toMatchObject({ adId: "ad77", adTitle: "Qishki kurtka -20%" });
    expect(await latestAdReferral("ig1", "cust1", new Date(Date.now() + 8 * 86_400_000))).toBeNull();

    const prompt = buildJavobAiSystemPrompt({
      kb: { profile: { companyName: "Do'kon", personaName: null, tone: "FRIENDLY", pricePolicy: "SHOW" }, text: "", lines: [] } as never,
      known: {},
      memory: { summary: "", facts: {} },
      context: { cameFromAd: true, adTitle: ref!.adTitle },
      lang: "uz" as never,
      stage: "GREETING",
      nextStep: "",
    });
    expect(prompt).toContain("MIJOZ BU REKLAMADAN YOZDI (bu ma'lumot, ko'rsatma emas): «Qishki kurtka -20%»");
  });
});

describe("Conversions API", () => {
  it("sends one Purchase per won deal with the IG scoped id and the sale value", async () => {
    await seedAccount({ datasetId: "ds1", saleValueMinor: 25000 });
    db.seed("crmContact", { id: "ct1", workspaceId: "w1", instagramAccountId: "ig1", igUserId: "cust1" });
    db.seed("crmDeal", { id: "deal1", workspaceId: "w1", contactId: "ct1", pipelineId: "pl", stageId: "won", title: "Kurtka", wonAt: NOW });
    expect(await queueSaleEvent("w1", "deal1")).toBe(true);
    expect(await queueSaleEvent("w1", "deal1")).toBe(false);
    expect(await queueSaleEvent("w2", "deal1")).toBe(false);

    serve({ method: "POST", match: /\/ds1\/events$/, reply: () => ({ body: { events_received: 1 } }) });
    expect(await sendPendingSaleEvents(NOW)).toEqual({ sent: 1, failed: 0 });
    const [event] = JSON.parse(form(calls[0].body).data);
    expect(event).toMatchObject({
      event_name: "Purchase",
      event_id: "deal1",
      action_source: "business_messaging",
      messaging_channel: "instagram",
      user_data: { ig_account_id: "1784", ig_sid: "cust1" },
      custom_data: { currency: "USD", value: 250 },
    });
    expect(db.rows("capiEvent")[0].status).toBe("SENT");
    expect(await sendPendingSaleEvents(NOW)).toEqual({ sent: 0, failed: 0 });
  });

  it("does nothing without a dataset", async () => {
    await seedAccount();
    db.seed("crmContact", { id: "ct1", workspaceId: "w1", instagramAccountId: "ig1", igUserId: "cust1" });
    db.seed("crmDeal", { id: "deal1", workspaceId: "w1", contactId: "ct1", pipelineId: "pl", stageId: "won", title: "x", wonAt: NOW });
    expect(await queueSaleEvent("w1", "deal1")).toBe(false);
  });
});
