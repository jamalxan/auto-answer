import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MetaApiError, TokenExpiredError } from "@/lib/meta/client";
import {
  containerParamsToBody,
  createComment,
  createContainer,
  getContainerStatus,
  getPublishedMedia,
  getPublishingLimit,
  publishContainer,
} from "@/lib/meta/publish";

const TOKEN = "IGQVJ-test-token";
const IG = "17841400000000001";
const BASE = "https://graph.instagram.com/v25.0";

type Call = { url: string; method: string; headers: Record<string, string>; body: URLSearchParams | null };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const signals: Array<AbortSignal | null> = [];

/** Stub fetch with a single canned JSON body and return the recorded calls. */
function stubFetch(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const rawBody = init?.body;
    let parsed: URLSearchParams | null = null;
    if (rawBody instanceof URLSearchParams) parsed = rawBody;
    else if (typeof rawBody === "string") parsed = new URLSearchParams(rawBody);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers, body: parsed });
    signals.push(init?.signal ?? null);
    // Response.url is read by handleResponse for the error message; a Response
    // built in tests has an empty url, which that code tolerates.
    return jsonResponse(body, status);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {
  process.env.META_GRAPH_API_VERSION = "v25.0";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.META_GRAPH_API_VERSION;
});

describe("containerParamsToBody", () => {
  it("maps userTags to a JSON user_tags array with x/y", () => {
    const body = containerParamsToBody({
      imageUrl: "https://cdn.example/a.jpg",
      userTags: [{ username: "alice", x: 0.5, y: 0.25 }, { username: "bob" }],
    });
    expect(body.get("image_url")).toBe("https://cdn.example/a.jpg");
    expect(JSON.parse(body.get("user_tags")!)).toEqual([
      { username: "alice", x: 0.5, y: 0.25 },
      { username: "bob" },
    ]);
  });

  it("encodes shareToFeed:false as the string \"false\"", () => {
    const body = containerParamsToBody({ videoUrl: "https://cdn.example/r.mp4", mediaType: "REELS", shareToFeed: false });
    expect(body.get("share_to_feed")).toBe("false");
    expect(body.get("media_type")).toBe("REELS");
    expect(body.get("video_url")).toBe("https://cdn.example/r.mp4");
  });

  it("encodes shareToFeed:true as the string \"true\"", () => {
    const body = containerParamsToBody({ mediaType: "REELS", shareToFeed: true });
    expect(body.get("share_to_feed")).toBe("true");
  });

  it("joins children with commas for a carousel", () => {
    const body = containerParamsToBody({ mediaType: "CAROUSEL", children: ["111", "222", "333"], caption: "hi" });
    expect(body.get("children")).toBe("111,222,333");
    expect(body.get("media_type")).toBe("CAROUSEL");
    expect(body.get("caption")).toBe("hi");
  });

  it("maps trialStrategy to trial_params JSON", () => {
    const body = containerParamsToBody({ mediaType: "REELS", trialStrategy: "MANUAL" });
    expect(JSON.parse(body.get("trial_params")!)).toEqual({ graduation_strategy: "MANUAL" });
  });

  it("maps isCarouselItem to is_carousel_item=true", () => {
    const body = containerParamsToBody({ imageUrl: "https://cdn.example/a.jpg", isCarouselItem: true });
    expect(body.get("is_carousel_item")).toBe("true");
  });

  it("maps the remaining fields and omits undefined ones", () => {
    const body = containerParamsToBody({
      videoUrl: "https://cdn.example/r.mp4",
      mediaType: "REELS",
      collaborators: ["carol", "dave"],
      altText: "alt",
      coverUrl: "https://cdn.example/c.jpg",
      thumbOffsetMs: 1500,
      audioName: "My Sound",
      locationId: "123456",
      isAiGenerated: true,
    });
    expect(JSON.parse(body.get("collaborators")!)).toEqual(["carol", "dave"]);
    expect(body.get("alt_text")).toBe("alt");
    expect(body.get("cover_url")).toBe("https://cdn.example/c.jpg");
    expect(body.get("thumb_offset")).toBe("1500");
    expect(body.get("audio_name")).toBe("My Sound");
    expect(body.get("location_id")).toBe("123456");
    expect(body.get("is_ai_generated")).toBe("true");
    // Not passed → not present (not "undefined" strings either).
    for (const key of ["image_url", "caption", "user_tags", "share_to_feed", "trial_params", "is_carousel_item", "children"]) {
      expect(body.has(key), key).toBe(false);
    }
    expect(Array.from(body.values()).some((v) => v === "undefined")).toBe(false);
  });

  it("returns an empty body for empty params", () => {
    expect(Array.from(containerParamsToBody({}).keys())).toEqual([]);
  });
});

describe("createContainer", () => {
  it("POSTs a form body to /{igUserId}/media with a bearer token and returns the id", async () => {
    const { calls } = stubFetch({ id: "container-1" });
    const result = await createContainer(TOKEN, IG, {
      imageUrl: "https://cdn.example/a.jpg",
      caption: "salom #a",
      userTags: [{ username: "alice", x: 0.1, y: 0.9 }],
    });
    expect(result).toEqual({ id: "container-1" });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe(`${BASE}/${IG}/media`);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(call.body?.get("image_url")).toBe("https://cdn.example/a.jpg");
    expect(call.body?.get("caption")).toBe("salom #a");
    expect(JSON.parse(call.body!.get("user_tags")!)).toEqual([{ username: "alice", x: 0.1, y: 0.9 }]);
    // Token travels in the header, never in the body or query string.
    expect(call.body?.has("access_token")).toBe(false);
    expect(call.url).not.toContain("access_token");
  });
});

describe("getContainerStatus", () => {
  it("GETs status_code,status and maps status_code to status", async () => {
    const { calls } = stubFetch({ id: "container-1", status_code: "FINISHED", status: "Finished: Media has been uploaded" });
    const result = await getContainerStatus(TOKEN, "container-1");
    expect(result).toEqual({ status: "FINISHED", statusText: "Finished: Media has been uploaded" });
    const call = calls[0];
    expect(call.method).toBe("GET");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/container-1`);
    expect(url.searchParams.get("fields")).toBe("status_code,status");
  });

  it("surfaces an ERROR status with its text", async () => {
    stubFetch({ id: "c", status_code: "ERROR", status: "Error: Media upload failed" });
    const result = await getContainerStatus(TOKEN, "c");
    expect(result.status).toBe("ERROR");
    expect(result.statusText).toBe("Error: Media upload failed");
  });
});

describe("publishContainer", () => {
  it("POSTs creation_id to /{igUserId}/media_publish and returns the media id", async () => {
    const { calls } = stubFetch({ id: "media-9" });
    const result = await publishContainer(TOKEN, IG, "container-1");
    expect(result).toEqual({ id: "media-9" });
    const call = calls[0];
    expect(call.url).toBe(`${BASE}/${IG}/media_publish`);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body?.get("creation_id")).toBe("container-1");
  });
});

describe("getPublishedMedia", () => {
  it("GETs id,permalink,media_product_type,timestamp for the media", async () => {
    const { calls } = stubFetch({
      id: "media-9",
      permalink: "https://www.instagram.com/p/abc/",
      media_product_type: "FEED",
      timestamp: "2026-10-24T14:00:00+0000",
    });
    const result = await getPublishedMedia(TOKEN, "media-9");
    expect(result).toEqual({
      id: "media-9",
      permalink: "https://www.instagram.com/p/abc/",
      media_product_type: "FEED",
      timestamp: "2026-10-24T14:00:00+0000",
    });
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/media-9`);
    expect(url.searchParams.get("fields")).toBe("id,permalink,media_product_type,timestamp");
    expect(calls[0].method).toBe("GET");
  });
});

describe("getPublishingLimit", () => {
  it("reads data[0].quota_usage and config.quota_total", async () => {
    const { calls } = stubFetch({ data: [{ quota_usage: 7, config: { quota_total: 100, quota_duration: 86400 } }] });
    const result = await getPublishingLimit(TOKEN, IG);
    expect(result).toEqual({ quotaUsage: 7, quotaTotal: 100 });
    const url = new URL(calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/${IG}/content_publishing_limit`);
    expect(url.searchParams.get("fields")).toBe("quota_usage,config");
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("defaults quota_total to 50 when config is missing", async () => {
    stubFetch({ data: [{ quota_usage: 3 }] });
    expect(await getPublishingLimit(TOKEN, IG)).toEqual({ quotaUsage: 3, quotaTotal: 50 });
  });

  it("defaults both to 0/50 when data is empty", async () => {
    stubFetch({ data: [] });
    expect(await getPublishingLimit(TOKEN, IG)).toEqual({ quotaUsage: 0, quotaTotal: 50 });
  });
});

describe("createComment", () => {
  it("POSTs message to /{mediaId}/comments and returns the comment id", async () => {
    const { calls } = stubFetch({ id: "comment-5" });
    const result = await createComment(TOKEN, "media-9", "Birinchi izoh #tag");
    expect(result).toEqual({ id: "comment-5" });
    const call = calls[0];
    expect(call.url).toBe(`${BASE}/media-9/comments`);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.body?.get("message")).toBe("Birinchi izoh #tag");
  });
});

describe("error handling via handleMetaResponse", () => {
  it("throws TokenExpiredError on a code 190 error body", async () => {
    stubFetch({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190, fbtrace_id: "t1" } }, 400);
    await expect(createContainer(TOKEN, IG, { imageUrl: "https://cdn.example/a.jpg" })).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("throws MetaApiError with code 9 on a publishing-limit error body", async () => {
    stubFetch({ error: { message: "Application request limit reached", type: "OAuthException", code: 9, fbtrace_id: "t2" } }, 400);
    const err = await publishContainer(TOKEN, IG, "container-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).not.toBeInstanceOf(TokenExpiredError);
    expect((err as MetaApiError).code).toBe(9);
  });

  it("throws on an error body even when the HTTP status is 200", async () => {
    stubFetch({ error: { message: "Unsupported post request.", type: "GraphMethodException", code: 100 } }, 200);
    await expect(getContainerStatus(TOKEN, "c")).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe("timeouts (M3)", () => {
  it("every Graph call carries an abort signal, and a timeout counts as ambiguous", async () => {
    signals.length = 0;
    stubFetch({ id: "c1" });
    await createContainer("tok", "ig1", { imageUrl: "https://x/a.jpg" });
    stubFetch({ status_code: "FINISHED" });
    await getContainerStatus("tok", "c1");
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    const { isAmbiguousFailure } = await import("@/lib/content/errors");
    expect(isAmbiguousFailure(new DOMException("The operation was aborted due to timeout", "TimeoutError"))).toBe(true);
  });
});
