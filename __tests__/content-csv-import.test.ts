/**
 * ETAP 13 Faza 2 — CSV import service (FR-I1, FR-I2): preview writes
 * nothing, commit refuses rows that still have errors, media are fetched
 * server-side behind the SSRF guard into the library, imported drafts are
 * scheduled once their media are READY, tenant isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  putObject: vi.fn(async () => undefined),
  enqueueMediaProcess: vi.fn(async () => undefined),
  schedulePrepare: vi.fn(async () => undefined),
  schedulePublish: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/content/queue", () => ({
  schedulePrepare: mocks.schedulePrepare,
  schedulePublish: mocks.schedulePublish,
  scheduleManualNotify: vi.fn(async () => undefined),
  removePostJobs: vi.fn(async () => undefined),
  enqueueMediaProcess: mocks.enqueueMediaProcess,
}));
vi.mock("@/lib/content/quota", () => ({
  accountQuota: vi.fn(async () => ({ used: 0, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" })),
  quotaWindowFull: () => false,
}));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ putObject: mocks.putObject, presignGet: async (key: string) => `https://b/${key}`, headObject: async () => null, deleteObject: async () => undefined }),
  mediaKey: (ws: string, ext: string) => `ws/${ws}/2026/10/${Math.random().toString(36).slice(2)}.${ext}`,
}));

import { commitCsvImport, previewCsvImport, scheduleImportedPosts } from "@/lib/content/csv-import";
import { importMediaFromUrl } from "@/lib/content/media-import";

const WS = "ws1";
const NOW = new Date("2026-10-24T10:00:00Z");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(60)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(60)]);

type Route = Buffer | { status: number; location?: string } | Error;
let routes: Record<string, Route> = {};
const fetchImpl = vi.fn(async (url: string | URL | Request) => {
  const key = String(url);
  const hit = routes[key];
  if (!hit) return new Response("nope", { status: 404 });
  if (hit instanceof Error) throw hit;
  if (Buffer.isBuffer(hit)) return new Response(new Uint8Array(hit), { status: 200, headers: { "content-type": "application/octet-stream" } });
  return new Response(null, { status: hit.status, headers: hit.location ? { location: hit.location } : {} });
}) as unknown as typeof fetch;
const publicDns = async () => ["93.184.216.34"];
const deps = { fetchImpl, resolveHost: publicDns, now: NOW };

const HEADER = "text,date,time,account,type,media_url_1,media_url_2,draft,campaign_keyword";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

beforeEach(() => {
  resetDb();
  routes = {};
  for (const m of Object.values(mocks)) m.mockClear();
  (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockClear();
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", timezone: "Asia/Tashkent", mediaStorageBytes: BigInt(0) });
  db.seed("workspace", { id: "ws2", name: "Other", ownerId: "u2", timezone: "Asia/Tashkent", mediaStorageBytes: BigInt(0) });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("instagramAccount", { id: "accX", workspaceId: "ws2", instagramId: "igX", username: "begona", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("triggerCampaign", { id: "tc1", workspaceId: WS, instagramAccountId: "acc1", name: "Narx", triggerType: "COMMENT", kind: "CAMPAIGN", keywords: ["narx"], active: false, mediaIds: [], mediaScope: "ANY" });
  db.seed("triggerCampaign", { id: "tcX", workspaceId: "ws2", instagramAccountId: "accX", name: "Begona", triggerType: "COMMENT", kind: "CAMPAIGN", keywords: ["narx"], active: false, mediaIds: [], mediaScope: "ANY" });
});

describe("previewCsvImport", () => {
  it("writes nothing and fetches nothing", async () => {
    routes["https://x.uz/a.jpg"] = JPEG;
    const p = await previewCsvImport(WS, csv("Salom,2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,,0,narx"), NOW);
    expect(p.valid).toBe(1);
    expect(p.rows[0].campaign?.id).toBe("tc1");
    expect(db.rows("mediaAsset")).toHaveLength(0);
    expect(db.rows("scheduledPost")).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tenant isolation: another workspace's account and campaign are never matched", async () => {
    const p = await previewCsvImport(WS, csv("x,2026-11-01,19:00,begona,POST,https://x.uz/a.jpg,,0,narx"), NOW);
    expect(p.rows[0].errors.join()).toMatch(/@begona bu workspace'da ulanmagan/);
    expect(p.rows[0].campaign).toBeNull();
  });

  it("a malformed file is a 400 with the reason", async () => {
    await expect(previewCsvImport(WS, 'text\n"open', NOW)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Qo'shtirnoq/) });
  });
});

describe("commitCsvImport", () => {
  const good = "Salom,2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,,0,narx";
  const bad = "x,2026-11-01,19:00,nobody,POST,https://x.uz/a.jpg,,0,";

  it("refuses the whole request when a ticked row still has an error — nothing is fetched or created", async () => {
    routes["https://x.uz/a.jpg"] = JPEG;
    await expect(commitCsvImport(WS, "u1", csv(good, bad), [2, 3], deps)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Xatoli qatorlar import qilinmaydi: 3/) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.rows("scheduledPost")).toHaveLength(0);
  });

  it("refuses row numbers that are not in the file and an empty selection", async () => {
    await expect(commitCsvImport(WS, "u1", csv(good), [9], deps)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/bunday qator yo'q: 9/) });
    await expect(commitCsvImport(WS, "u1", csv(good), [], deps)).rejects.toMatchObject({ status: 400 });
  });

  it("imports only the ticked good rows: media into the library, DRAFT with the planned time, campaign linked", async () => {
    routes["https://x.uz/a.jpg"] = JPEG;
    const r = await commitCsvImport(WS, "u1", csv(good, bad), [2], deps);
    expect(r).toMatchObject({ created: 1, failed: 0 });
    const post = db.rows("scheduledPost")[0];
    expect(post).toMatchObject({ workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", status: "DRAFT", caption: "Salom", labels: ["csv-import"] });
    expect(new Date(post.scheduledAt as Date).toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(r.toSchedule).toEqual([post.id]);
    const asset = db.rows("mediaAsset")[0];
    expect(asset).toMatchObject({ workspaceId: WS, kind: "IMAGE", mimeType: "image/jpeg", status: "PROCESSING" });
    expect(mocks.putObject).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueMediaProcess).toHaveBeenCalledWith(asset.id);
    expect(Number(db.rows("workspace").find((w) => w.id === WS)!.mediaStorageBytes)).toBe(JPEG.length);
    expect(db.rows("triggerCampaign").find((c) => c.id === "tc1")!.scheduledPostId).toBe(post.id);
    expect(db.rows("operationalEvent").some((e) => /CSV import/.test(String(e.message)))).toBe(true);
  });

  it("the downloaded bytes decide the kind: an extension-less POST link that is a video becomes a feed video", async () => {
    routes["https://x.uz/file?id=1"] = MP4;
    const r = await commitCsvImport(WS, "u1", csv("v,2026-11-01,19:00,jamalxann,POST,https://x.uz/file?id=1,,0,"), [2], deps);
    expect(r.created).toBe(1);
    expect(db.rows("scheduledPost")[0].type).toBe("FEED_VIDEO");
    expect(db.rows("mediaAsset")[0]).toMatchObject({ kind: "VIDEO", mimeType: "video/mp4" });
  });

  it("a REEL whose link turns out to be an image fails at commit and its download is released", async () => {
    routes["https://x.uz/file?id=2"] = JPEG;
    const r = await commitCsvImport(WS, "u1", csv("r,2026-11-01,19:00,jamalxann,REEL,https://x.uz/file?id=2,,0,"), [2], deps);
    expect(r.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/rasm bo'lmaydi/) });
    expect(db.rows("scheduledPost")).toHaveLength(0);
    expect(db.rows("mediaAsset")[0].status).toBe("DELETED");
  });

  it("one failing download fails only its row; the other rows are imported", async () => {
    routes["https://x.uz/a.jpg"] = JPEG;
    routes["https://x.uz/b.jpg"] = JPEG;
    const r = await commitCsvImport(WS, "u1", csv("ok,2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,,0,", "carousel,2026-11-01,19:30,jamalxann,POST,https://x.uz/b.jpg,https://x.uz/missing.jpg,0,"), [2, 3], deps);
    expect(r).toMatchObject({ created: 1, failed: 1 });
    expect(r.results[1].error).toMatch(/media_url_2: fayl yuklab olinmadi/);
    // b.jpg was downloaded for the failed row and is released again.
    expect(db.rows("mediaAsset").filter((a) => a.status === "DELETED")).toHaveLength(1);
  });

  it("a draft row is created without asking for a slot", async () => {
    routes["https://x.uz/a.jpg"] = JPEG;
    const r = await commitCsvImport(WS, "u1", csv("d,,,jamalxann,POST,https://x.uz/a.jpg,,1,"), [2], deps);
    expect(r.created).toBe(1);
    expect(r.toSchedule).toEqual([]);
    expect(db.rows("scheduledPost")[0].scheduledAt ?? null).toBeNull();
  });
});

describe("SSRF guard on the media download", () => {
  it("refuses a hostname that resolves to a private address", async () => {
    routes["https://evil.example/a.jpg"] = JPEG;
    await expect(importMediaFromUrl(WS, "u1", "https://evil.example/a.jpg", { fetchImpl, resolveHost: async () => ["10.0.0.5"] })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/ichki/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-checks every redirect hop (public → metadata IP is refused)", async () => {
    routes["https://x.uz/r.jpg"] = { status: 302, location: "https://169.254.169.254/latest/meta-data" };
    await expect(importMediaFromUrl(WS, "u1", "https://x.uz/r.jpg", { fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({ message: expect.stringMatching(/ichki/) });
    expect(db.rows("mediaAsset")).toHaveLength(0);
  });

  it("refuses http, loopback literals and IPv4-mapped IPv6", async () => {
    for (const url of ["http://x.uz/a.jpg", "https://127.0.0.1/a.jpg", "https://[::ffff:127.0.0.1]/a.jpg"]) {
      await expect(importMediaFromUrl(WS, "u1", url, { fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({ status: 400 });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses HEIC and unknown bytes by magic, whatever the server claims", async () => {
    routes["https://x.uz/h.jpg"] = HEIC;
    routes["https://x.uz/t.jpg"] = Buffer.from("<html>not an image at all</html>");
    await expect(importMediaFromUrl(WS, "u1", "https://x.uz/h.jpg", { fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({ message: expect.stringMatching(/HEIC/) });
    await expect(importMediaFromUrl(WS, "u1", "https://x.uz/t.jpg", { fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({ message: expect.stringMatching(/turi qabul qilinmaydi/) });
  });

  it("respects the workspace storage quota", async () => {
    vi.stubEnv("CONTENT_STORAGE_QUOTA_BYTES", "10");
    routes["https://x.uz/a.jpg"] = JPEG;
    await expect(importMediaFromUrl(WS, "u1", "https://x.uz/a.jpg", { fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({ status: 413 });
    vi.unstubAllEnvs();
    expect(mocks.putObject).not.toHaveBeenCalled();
  });
});

describe("scheduleImportedPosts", () => {
  it("waits while media is processing, then schedules at the planned time", async () => {
    routes["https://x.uz/a.jpg"] = JPEG;
    const r = await commitCsvImport(WS, "u1", csv("Salom,2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,,0,"), [2], deps);
    const [postId] = r.toSchedule;
    expect(await scheduleImportedPosts(WS, [postId], NOW)).toMatchObject({ pending: [postId], scheduled: [], failed: [] });

    const asset = db.rows("mediaAsset")[0];
    Object.assign(asset, { status: "READY", width: 1080, height: 1350, preparedKey: "p", thumbKey: "t", preparedBytes: 1000 });
    const done = await scheduleImportedPosts(WS, [postId], NOW);
    expect(done.scheduled).toEqual([{ postId, scheduledAt: "2026-11-01T14:00:00.000Z" }]);
    expect(db.rows("scheduledPost")[0].status).toBe("SCHEDULED");
    expect(mocks.schedulePublish).toHaveBeenCalled();
    // Idempotent: a second call reports it as scheduled without re-arming.
    mocks.schedulePublish.mockClear();
    expect((await scheduleImportedPosts(WS, [postId], NOW)).scheduled).toHaveLength(1);
    expect(mocks.schedulePublish).not.toHaveBeenCalled();
  });

  it("reports failed media and foreign ids", async () => {
    routes["https://x.uz/a.jpg"] = JPEG;
    const r = await commitCsvImport(WS, "u1", csv("Salom,2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,,0,"), [2], deps);
    db.rows("mediaAsset")[0].status = "FAILED";
    db.seed("scheduledPost", { id: "foreign", workspaceId: "ws2", instagramAccountId: "accX", type: "FEED_IMAGE", status: "DRAFT", scheduledAt: new Date("2026-11-01T14:00:00Z") });
    const out = await scheduleImportedPosts(WS, [r.toSchedule[0], "foreign"], NOW);
    expect(out.failed.map((f) => f.error)).toEqual([expect.stringMatching(/qayta ishlanmadi/), "Post topilmadi"]);
  });
});
