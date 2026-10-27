import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn(async (...args: [string, string]) => args.length));
const meta = vi.hoisted(() => ({
  media: [] as Array<Record<string, unknown>>,
  insights: {} as Record<string, Record<string, number>>,
  rejectMetrics: new Set<string>(),
}));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({ set: async () => "OK", get: async () => null }) }));
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: notify }));
vi.mock("../lib/meta/oauth", () => ({ decryptToken: (v: string) => `tok:${v}` }));
vi.mock("../lib/content/queue", () => ({ schedulePublish: vi.fn(), hasLivePublishJob: vi.fn(async () => false), hasContentQueueBackend: () => false, cancelPublishJobs: vi.fn() }));
vi.mock("../lib/content/storage", () => ({ getStorage: () => ({ presignGet: async (k: string) => `https://s/${k}` }), isStorageConfigured: () => true }));
vi.mock("../lib/content/insights", () => ({
  bestTimes: async () => ({ timezone: "Asia/Tashkent", scores: null, top: [{ weekday: 2, hour: 19, score: 1 }] }),
  zonedWeekHour: () => ({ weekday: 0, hour: 0 }),
}));
vi.mock("../lib/meta/client", async (original) => ({
  ...(await original<typeof import("../lib/meta/client")>()),
  getAccountMedia: vi.fn(async () => meta.media),
  getMediaInsights: vi.fn(async (_token: string, mediaId: string, metrics: string[]) => {
    for (const m of metrics) if (meta.rejectMetrics.has(m)) throw new Error(`(#100) metric ${m} not supported`);
    const all = meta.insights[mediaId] ?? {};
    return Object.fromEntries(metrics.filter((m) => m in all).map((m) => [m, all[m]]));
  }),
}));

import type { LLMProvider, LlmRequest } from "../lib/assistant/llm/provider";
import { analyzeStat, pickFrames, queueAnalyses, AnalysisError } from "../lib/content-intel/analyze";
import { keywordCovered, runChecks } from "../lib/content-intel/checks";
import { createHookExperiment, evaluateExperiments, ExperimentError } from "../lib/content-intel/experiments";
import { attributeBusiness, collectAccountStats, median, refreshAfterMs, rescore, scoreLabel } from "../lib/content-intel/metrics";
import { generatePlan, generateScenario, itemToDraft } from "../lib/content-intel/plan";
import { buildWeeklyReport, reportText, runWeeklyReports, tagCorrelations, weekStartOf } from "../lib/content-intel/report";
import { db, resetDb } from "./helpers/db-instance";

const DAY = 86_400_000;
const NOW = new Date("2026-10-28T10:00:00Z"); // Wednesday, 15:00 Tashkent

function seed() {
  db.seed("workspace", { id: "w1", ownerId: "u1", timezone: "Asia/Tashkent" });
  db.seed("user", { id: "u1", email: "o@example.com" });
  db.seed("workspaceMember", { workspaceId: "w1", userId: "u1", role: "OWNER" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "dokon", instagramId: "ig1", accessToken: "enc", tokenStatus: "ACTIVE", canPublish: true });
}

function stat(id: string, over: Record<string, unknown> = {}) {
  return db.seed("contentPostStat", {
    id,
    workspaceId: "w1",
    instagramAccountId: "a1",
    igMediaId: `m-${id}`,
    mediaType: "VIDEO",
    productType: "REELS",
    publishedAt: new Date(NOW.getTime() - 2 * DAY),
    views: 1000,
    fetchedAt: NOW,
    ...over,
  });
}

function fakeProvider(answer: unknown, seen: LlmRequest[] = []): LLMProvider {
  return {
    name: "fake",
    model: "fake-1",
    complete: async (request) => {
      seen.push(request);
      return { json: typeof answer === "function" ? (answer as (r: LlmRequest) => unknown)(request) : answer, inputTokens: 100, outputTokens: 50, model: "fake-1", latencyMs: 5 };
    },
    costUsd: () => 0.001,
  };
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  meta.media = [];
  meta.insights = {};
  meta.rejectMetrics = new Set();
  vi.stubEnv("CONTENT_ANALYSIS_MONTHLY_LIMIT", "");
  vi.stubEnv("TRIAL_REELS_DAILY_LIMIT", "");
});

describe("metrics and scoring", () => {
  it("median, labels and refresh cadence", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(scoreLabel(2.44)).toBe("2.4× yaxshiroq");
    expect(scoreLabel(0.5)).toBe("0.5× — medianadan past");
    expect(scoreLabel(1)).toBe("o'rtacha darajada");
    expect(scoreLabel(null)).toBe("solishtirish uchun post kam");
    expect(refreshAfterMs(DAY)).toBe(6 * 3_600_000);
    expect(refreshAfterMs(10 * DAY)).toBe(DAY);
    expect(refreshAfterMs(60 * DAY)).toBe(7 * DAY);
  });

  it("collects posts with the views metric, tolerates unknown extras, skips stories and scores against the median", async () => {
    seed();
    const at = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
    meta.media = [
      { id: "r1", media_type: "VIDEO", media_product_type: "REELS", timestamp: at(1), permalink: "https://ig/p/r1", caption: "Narx videosi" },
      { id: "r2", media_type: "VIDEO", media_product_type: "REELS", timestamp: at(5) },
      { id: "f1", media_type: "IMAGE", media_product_type: "FEED", timestamp: at(8) },
      { id: "s1", media_type: "IMAGE", media_product_type: "STORY", timestamp: at(1) },
      { id: "old", media_type: "IMAGE", media_product_type: "FEED", timestamp: at(200) },
    ];
    meta.insights = {
      r1: { views: 4000, reach: 3000, likes: 10, comments: 5, saved: 7, shares: 2, total_interactions: 24, ig_reels_avg_watch_time: 5400 },
      r2: { views: 1000, reach: 900 },
      f1: { views: 500, reach: 400, follows: 3 },
    };
    meta.rejectMetrics = new Set(["reels_skip_rate"]);
    const result = await collectAccountStats("a1", NOW);
    expect(result).toMatchObject({ fetched: 3, failed: 0, error: null });
    const rows = db.rows("contentPostStat");
    expect(rows.map((r) => r.igMediaId).sort()).toEqual(["f1", "r1", "r2"]);
    const r1 = rows.find((r) => r.igMediaId === "r1")!;
    expect(r1).toMatchObject({ views: 4000, saves: 7, avgWatchMs: 5400, skipRate: null, caption: "Narx videosi", score: 4 });
    expect(rows.find((r) => r.igMediaId === "f1")).toMatchObject({ follows: 3, score: 0.5 });

    // A second pass right away re-reads nothing.
    expect((await collectAccountStats("a1", NOW)).skipped).toBe(3);
  });

  it("no score until three posts can be compared", async () => {
    seed();
    stat("a", { views: 100 });
    stat("b", { views: 300 });
    expect(await rescore("a1", NOW)).toBeNull();
    expect(db.rows("contentPostStat").every((r) => r.score === null)).toBe(true);
  });

  it("attributes comments → DMs → leads (14-day window or post URL) → won deals", async () => {
    seed();
    const published = new Date(NOW.getTime() - 10 * DAY);
    stat("p", { igMediaId: "m1", permalink: "https://ig/p/m1", publishedAt: published });
    const comment = (sender: string, at: Date) =>
      db.seed("instagramEvent", { workspaceId: "w1", instagramAccountId: "a1", eventType: "COMMENT", senderId: sender, messageId: `c-${sender}`, mediaId: "m1", timestamp: at, rawPayload: {} });
    comment("u1", new Date(published.getTime() + DAY));
    comment("u2", new Date(published.getTime() + DAY));
    comment("u1", new Date(published.getTime() + 2 * DAY));
    db.seed("conversation", { id: "cv1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1", createdAt: new Date(published.getTime() + DAY + 60_000) });
    const lead = (id: string, ig: string, at: Date, postUrl: string | null = null) =>
      db.seed("lead", { id, workspaceId: "w1", instagramAccountId: "a1", igUserId: ig, createdAt: at, isTest: false, postUrl, idempotencyKey: id });
    lead("L1", "u1", new Date(published.getTime() + 2 * DAY));
    lead("L2", "u2", new Date(published.getTime() + 20 * DAY)); // after the 14-day window
    lead("L3", "u9", new Date(published.getTime() + 3 * DAY), "https://ig/p/m1");
    db.seed("crmDeal", { id: "d1", workspaceId: "w1", contactId: "c1", pipelineId: "p1", stageId: "s1", leadId: "L1", title: "x", wonAt: NOW });
    db.seed("crmDeal", { id: "d2", workspaceId: "w1", contactId: "c3", pipelineId: "p1", stageId: "s1", leadId: "L3", title: "y", wonAt: null });
    await attributeBusiness("a1", NOW);
    expect(db.rows("contentPostStat")[0]).toMatchObject({ bizComments: 3, bizDms: 1, bizLeads: 2, bizSales: 1 });
  });
});

describe("typical-error checks", () => {
  it("flags each audit rule", () => {
    expect(
      runChecks({
        isVideo: true,
        tags: { hookStartSec: 4, firstFrameHasText: false, hasSubtitles: false, aspect: 1, textInUnsafeZone: true, hasCta: false, ctaKeyword: "NARX" },
        keywordLinked: false,
        slotScore: 0.1,
      })
    ).toEqual(["hook_late", "no_first_frame_text", "no_subtitles", "not_vertical", "text_unsafe_zone", "no_cta", "keyword_unlinked", "bad_time"]);
    expect(runChecks({ isVideo: true, tags: { hookStartSec: 1, firstFrameHasText: true, hasSubtitles: true, aspect: 0.5625, hasCta: true, ctaKeyword: "NARX" }, keywordLinked: true, slotScore: 0.9 })).toEqual([]);
    // An image is not judged on video rules.
    expect(runChecks({ isVideo: false, tags: { hasSubtitles: false, aspect: 1, hasCta: true }, keywordLinked: null, slotScore: null })).toEqual([]);
  });

  it("a keyword counts as linked only when an active campaign answers it on this post", () => {
    const automation = { isActive: true, postId: "m1", matchAnyPost: false, matchAnyWord: false, keywords: ["narx"] };
    expect(keywordCovered("NARX", "m1", [automation], [])).toBe(true);
    expect(keywordCovered("NARX", "m2", [automation], [])).toBe(false);
    expect(keywordCovered("NARX", "m1", [{ ...automation, isActive: false }], [])).toBe(false);
    expect(keywordCovered("NARX", "m9", [], [{ active: true, mediaScope: "ANY", mediaIds: [], keywords: ["Narx"] }])).toBe(true);
    expect(keywordCovered("NARX", "m9", [], [{ active: true, mediaScope: "SPECIFIC", mediaIds: ["m1"], keywords: ["narx"] }])).toBe(false);
  });
});

describe("video analysis", () => {
  const frame = (n: number) => Buffer.from(`frame-${n}`);

  it("sends the first three seconds apart and at most twelve frames", () => {
    const { first, rest } = pickFrames(Array.from({ length: 40 }, (_, i) => frame(i)));
    expect(first.map(String)).toEqual(["frame-0", "frame-1", "frame-2"]);
    expect(rest).toHaveLength(9);
    expect(pickFrames([frame(0), frame(1)]).rest).toHaveLength(0);
  });

  it("respects the monthly limit", async () => {
    seed();
    vi.stubEnv("CONTENT_ANALYSIS_MONTHLY_LIMIT", "2");
    stat("a");
    stat("b", { igMediaId: "m-b" });
    stat("c", { igMediaId: "m-c" });
    expect(await queueAnalyses("w1", ["a", "b", "c"], NOW)).toBe(2);
    await expect(queueAnalyses("w1", ["c"], NOW)).rejects.toBeInstanceOf(AnalysisError);
    await expect(queueAnalyses("w2", ["a"], NOW)).rejects.toThrow();
  });

  it("tags a Reel from frames + transcript and records the typical errors", async () => {
    seed();
    stat("a", { igMediaId: "m1", caption: "Yangi kolleksiya. NARX deb yozing", score: 2.4 });
    await queueAnalyses("w1", ["a"], NOW);
    const seen: LlmRequest[] = [];
    const provider = fakeProvider(
      { hookType: "savol", format: "talking_head", topic: "yangi kolleksiya", hasSubtitles: false, hasCta: true, ctaKeyword: "NARX", hookStartSec: 1, firstFrameHasText: true, textInUnsafeZone: false, note: "Savol bilan boshlangan." },
      seen
    );
    const outcome = await analyzeStat("a", {
      provider,
      mediaUrls: async () => ({ kind: "video", urls: ["https://cdn/v.mp4"] }),
      download: async () => Buffer.from("video"),
      extractVideo: async () => ({ frames: Array.from({ length: 20 }, (_, i) => frame(i)), audio: Buffer.from("a"), width: 1080, height: 1920, durationSec: 20 }),
      transcribe: async () => "Bilasizmi, eng arzon narx qayerda?",
      slotScore: async () => 0.2,
    });
    expect(outcome).toEqual({ status: "DONE", issues: ["no_subtitles", "keyword_unlinked", "bad_time"] });
    expect(seen[0].images).toHaveLength(12);
    expect(seen[0].messages[0].content).toContain("Bilasizmi, eng arzon narx qayerda?");
    expect(seen[0].usage).toEqual({ workspaceId: "w1", kind: "content_analysis" });
    const row = db.rows("contentAnalysis")[0];
    expect(row).toMatchObject({ status: "DONE", model: "fake-1", transcript: "Bilasizmi, eng arzon narx qayerda?" });
    expect(row.tags).toMatchObject({ hookType: "savol", aspect: 0.563, durationSec: 20, ctaKeyword: "NARX" });
  });

  it("records a failure instead of throwing", async () => {
    seed();
    stat("a");
    await queueAnalyses("w1", ["a"], NOW);
    const outcome = await analyzeStat("a", {
      provider: fakeProvider({}),
      mediaUrls: async () => ({ kind: "video", urls: ["u"] }),
      download: async () => Buffer.from("v"),
      extractVideo: async () => {
        throw Object.assign(new Error("spawn ffmpeg ENOENT"), {});
      },
    });
    expect(outcome.status).toBe("FAILED");
    expect(db.rows("contentAnalysis")[0]).toMatchObject({ status: "FAILED", error: "Serverda ffmpeg o'rnatilmagan" });
  });
});

describe("weekly report and correlations", () => {
  function analysed(id: string, score: number, tags: Record<string, unknown>, issues: string[] = [], publishedAt = new Date(NOW.getTime() - 5 * DAY)) {
    stat(id, { igMediaId: `m-${id}`, score, publishedAt, caption: `Post ${id}` });
    db.seed("contentAnalysis", { workspaceId: "w1", statId: id, status: "DONE", tags, issues });
  }

  it("needs three posts per tag value and compares medians", async () => {
    seed();
    analysed("a", 2, { hookType: "savol" });
    analysed("b", 1.8, { hookType: "savol" });
    analysed("c", 30, { hookType: "savol" });
    analysed("d", 0.5, { hookType: "natija" });
    const correlations = await tagCorrelations("a1", NOW);
    expect(correlations).toEqual([{ tag: "hookType", value: "savol", label: "Hook: savol", medianScore: 2, posts: 3 }]);
  });

  it("weekStartOf is Monday 00:00 in the workspace zone", () => {
    expect(weekStartOf(NOW, "Asia/Tashkent").toISOString()).toBe("2026-10-25T19:00:00.000Z");
  });

  it("builds the week with top / bottom, issues and the business funnel", async () => {
    seed();
    const week = weekStartOf(NOW, "Asia/Tashkent");
    const inWeek = new Date(week.getTime() + DAY);
    for (const [id, score] of [["a", 3], ["b", 1], ["c", 0.4], ["d", 0.8]] as const) {
      analysed(id, score, { note: id === "a" ? "Natija bilan boshlangan" : undefined }, id === "c" ? ["no_subtitles"] : [], inWeek);
    }
    db.rows("contentPostStat")[0].bizLeads = 4;
    const body = await buildWeeklyReport("a1", week, NOW);
    expect(body.totals).toMatchObject({ posts: 4, leads: 4 });
    expect(body.top[0]).toMatchObject({ statId: "a", scoreLabel: "3× yaxshiroq", note: "Natija bilan boshlangan" });
    expect(body.bottom.map((p) => p.statId)).toEqual(["c", "d"]);
    expect(body.issues).toEqual([{ code: "no_subtitles", text: "Subtitr yo'q — ko'pchilik ovozsiz ko'radi", posts: 1 }]);
    expect(reportText("dokon", body)).toContain("4 lid");
  });

  it("sends last week's report once, on Monday from 09:00", async () => {
    seed();
    const lastWeek = weekStartOf(new Date("2026-10-21T10:00:00Z"), "Asia/Tashkent");
    stat("a", { publishedAt: new Date(lastWeek.getTime() + DAY), score: 1.5 });
    const mondayEarly = new Date("2026-10-26T03:00:00Z"); // 08:00 Tashkent
    expect(await runWeeklyReports(mondayEarly)).toBe(0);
    const mondayLate = new Date("2026-10-26T05:00:00Z"); // 10:00
    expect(await runWeeklyReports(mondayLate)).toBe(1);
    expect(await runWeeklyReports(new Date("2026-10-26T06:00:00Z"))).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(db.rows("contentReport")).toHaveLength(1);
  });
});

describe("plan, scenario and drafts", () => {
  it("keeps items inside the 14 days, drops invented evidence, writes the scenario and makes a draft with the CTA campaign", async () => {
    seed();
    stat("a", { score: 2 });
    const plan = await generatePlan("w1", "a1", "u1", {
      now: NOW,
      provider: fakeProvider({
        items: [
          { date: "2026-10-30", time: "19:00", format: "reel", topic: "Narx sirlari", hookIdeas: ["Bilasizmi?"], why: "Savol hook 2× (a)", evidence: ["a", "invented"] },
          { date: "2026-12-30", time: "19:00", format: "reel", topic: "Juda uzoq", hookIdeas: [], why: "", evidence: [] },
          { date: "2026-10-29", time: "99:99", format: "story", topic: "Kulisa", hookIdeas: [], why: "", evidence: [] },
        ],
      }),
    });
    const items = plan.items as unknown as Array<{ key: string; date: string; time: string; evidence: string[]; topic: string }>;
    expect(items.map((i) => i.topic)).toEqual(["Kulisa", "Narx sirlari"]);
    expect(items[0].time).toBe("19:00");
    expect(items[1].evidence).toEqual(["a"]);

    const key = items[1].key;
    const scenario = await generateScenario("w1", plan.id, key, {
      provider: fakeProvider({
        hooks: ["Bilasizmi?", "3 kunda natija", "Xato qilmang"],
        script: [{ sec: "0-3", text: "Bilasizmi?" }],
        shotList: [{ shot: "yaqin", camera: "statik" }],
        audio: { tempo: "tez", voice: "do'stona", music: "trend" },
        subtitles: { style: "katta, sariq", keywords: ["narx"] },
        caption: "Narxlarni bilmoqchimisiz? NARX deb yozing",
        ctaKeyword: "narx ",
        dmMessage: "Narxlar ro'yxati: ...",
        upload: { cover: "Narx yozuvi", firstComment: "Savollar bo'lsa yozing" },
      }),
    });
    expect(scenario.ctaKeyword).toBe("NARX");
    expect(scenario.upload).toMatchObject({ aspect: "9:16", resolution: "1080×1920", publishAt: "2026-10-30 19:00" });

    const draft = await itemToDraft("w1", plan.id, key, "u1");
    expect(draft.created).toBe(true);
    const post = db.rows("scheduledPost").find((p) => p.id === draft.postId)!;
    expect(post).toMatchObject({ type: "REEL", status: "DRAFT", caption: "Narxlarni bilmoqchimisiz? NARX deb yozing", isAiGenerated: true });
    const campaign = db.rows("automation").find((a) => a.scheduledPostId === draft.postId);
    expect(campaign?.keywords).toEqual(["NARX"]);
    // Twice is still one draft.
    expect((await itemToDraft("w1", plan.id, key, "u1")).created).toBe(false);
  });

  it("another workspace cannot open the plan", async () => {
    seed();
    stat("a");
    const plan = await generatePlan("w1", "a1", null, { now: NOW, provider: fakeProvider({ items: [{ date: "2026-10-30", time: "10:00", format: "image", topic: "T", hookIdeas: [], why: "", evidence: [] }] }) });
    await expect(itemToDraft("w2", plan.id, "i1", null)).rejects.toThrow("Reja topilmadi");
  });
});

describe("Trial Reels hook tests", () => {
  it("creates one trial draft per hook within the daily limit", async () => {
    seed();
    vi.stubEnv("TRIAL_REELS_DAILY_LIMIT", "3");
    const now = new Date(); // the drafts are stamped with the real clock
    const experiment = await createHookExperiment("w1", "u1", { accountId: "a1", title: "Narx", hooks: ["Bilasizmi?", "3 kunda natija", "Bilasizmi?"] }, now);
    const variants = experiment.variants as unknown as Array<{ hook: string; postId: string }>;
    expect(variants.map((v) => v.hook)).toEqual(["Bilasizmi?", "3 kunda natija"]);
    expect(db.rows("scheduledPost").filter((p) => p.type === "TRIAL_REEL" && p.trialStrategy === "MANUAL")).toHaveLength(2);
    await expect(createHookExperiment("w1", "u1", { accountId: "a1", title: "x", hooks: ["a", "b"] }, now)).rejects.toBeInstanceOf(ExperimentError);
    await expect(createHookExperiment("w1", "u1", { accountId: "a1", title: "x", hooks: ["only"] }, now)).rejects.toThrow("Kamida 2");
  });

  it("decides after 48 h by views and tells the owner; a dropped variant cancels a two-way test", async () => {
    seed();
    const experiment = await createHookExperiment("w1", "u1", { accountId: "a1", title: "Narx", hooks: ["A hook", "B hook"] }, NOW);
    const posts = db.rows("scheduledPost");
    posts.forEach((p, i) => Object.assign(p, { status: "PUBLISHED", igMediaId: `ig-${i}`, publishedAt: new Date(NOW.getTime() - DAY) }));
    const views: Record<string, number> = { "ig-0": 300, "ig-1": 900 };
    expect(await evaluateExperiments(NOW, async (_a, id) => views[id])).toBe(0); // only 24 h
    expect(await evaluateExperiments(new Date(NOW.getTime() + 2 * DAY), async (_a, id) => views[id])).toBe(1);
    const done = db.rows("hookExperiment").find((e) => e.id === experiment.id)!;
    expect(done).toMatchObject({ status: "DONE", winnerIndex: 1 });
    expect(notify.mock.calls[0][1]).toContain("🏆 B hook — 900");

    const second = await createHookExperiment("w1", "u1", { accountId: "a1", title: "Ikkinchi", hooks: ["C", "D"] }, NOW);
    const ids = (second.variants as unknown as Array<{ postId: string }>).map((v) => v.postId);
    db.rows("scheduledPost").find((p) => p.id === ids[0])!.status = "CANCELED";
    await evaluateExperiments(NOW, async () => 1);
    expect(db.rows("hookExperiment").find((e) => e.id === second.id)?.status).toBe("CANCELED");
  });
});
