/**
 * ETAP 4.3 — attachment classification, SSRF guard, size cap, sniffing,
 * per-conversation media cap. No network: fetch and DNS are injected.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentError,
  AUDIO_MIME_TYPES,
  IMAGE_MIME_TYPES,
  MEDIA_SLOT_SCRIPT,
  acquireMediaSlot,
  assertPublicMediaUrl,
  classifyAttachments,
  describeMediaUrl,
  fetchAttachment,
  fetchAudioAttachment,
  fetchImageAttachment,
  maxAudioBytes,
  maxImageBytes,
  mediaWindowAllows,
  normalizeContentType,
  sniffMime,
} from "../lib/javobai/attachments";

const publicDns = async () => ["157.240.1.1"];
const CDN = "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=abc";

const ogg = (size = 64) => Buffer.concat([Buffer.from("OggS"), Buffer.alloc(size - 4, 1)]);
const jpeg = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 1)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const webp = () => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);
const wav = () => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(16)]);
const m4a = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), Buffer.alloc(16)]);
const mp3 = () => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32)]);
const aac = () => Buffer.concat([Buffer.from([0xff, 0xf1, 0x50]), Buffer.alloc(32)]);

function fetchReturning(body: Buffer | ReadableStream<Uint8Array>, init: ResponseInit = {}) {
  return vi.fn(async () => new Response(body as BodyInit, { status: 200, ...init }));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("classifyAttachments", () => {
  it("sorts Meta attachment types into audio / images / other", () => {
    const result = classifyAttachments([
      { type: "audio", url: "https://a/1" },
      { type: "IMAGE", url: "https://a/2" },
      { type: "video", url: "https://a/3" },
      { type: "share", url: "https://a/4" },
      { type: "story_mention", url: "https://a/5" },
      { type: "ig_reel", url: "https://a/6" },
      { type: "file", url: "https://a/7" },
      { type: "image", url: "" }, // no url: dropped
    ]);
    expect(result.audio).toEqual([{ type: "audio", url: "https://a/1" }]);
    expect(result.images).toEqual([{ type: "image", url: "https://a/2" }]);
    expect(result.other.map((o) => o.type)).toEqual(["video", "share", "story_mention", "ig_reel", "file"]);
  });

  it("handles a missing list", () => {
    expect(classifyAttachments(undefined)).toEqual({ audio: [], images: [], other: [] });
    expect(classifyAttachments(null)).toEqual({ audio: [], images: [], other: [] });
  });
});

describe("sniffMime", () => {
  it("recognises the audio and image containers we accept", () => {
    expect(sniffMime(ogg())).toBe("audio/ogg");
    expect(sniffMime(m4a())).toBe("audio/mp4");
    expect(sniffMime(mp3())).toBe("audio/mpeg");
    expect(sniffMime(wav())).toBe("audio/wav");
    expect(sniffMime(aac())).toBe("audio/aac");
    expect(sniffMime(jpeg())).toBe("image/jpeg");
    expect(sniffMime(png())).toBe("image/png");
    expect(sniffMime(webp())).toBe("image/webp");
  });

  it("returns null for unknown or tiny buffers", () => {
    expect(sniffMime(Buffer.from("<html>hello world</html>"))).toBeNull();
    expect(sniffMime(Buffer.from("OggS"))).toBeNull();
    expect(sniffMime(Buffer.from("GIF89a" + "x".repeat(20)))).toBeNull();
  });

  it("normalizes a content-type header", () => {
    expect(normalizeContentType("audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(normalizeContentType("Image/JPEG")).toBe("image/jpeg");
    expect(normalizeContentType(null)).toBeNull();
  });
});

describe("assertPublicMediaUrl (SSRF)", () => {
  const cases: Array<[string, string]> = [
    ["http://lookaside.fbsbx.com/x", "bad_url"],
    ["ftp://lookaside.fbsbx.com/x", "bad_url"],
    ["not a url", "bad_url"],
    ["https://user:pw@lookaside.fbsbx.com/x", "bad_url"],
    ["https://localhost/x", "private_address"],
    ["https://127.0.0.1/x", "private_address"],
    ["https://10.0.0.5/x", "private_address"],
    ["https://169.254.169.254/latest/meta-data", "private_address"],
    ["https://[::1]/x", "private_address"],
    ["https://[::ffff:127.0.0.1]/x", "private_address"],
    ["https://metadata.internal/x", "private_address"],
    ["https://redis/x", "private_address"],
  ];
  for (const [url, code] of cases) {
    it(`rejects ${url} with ${code}`, async () => {
      await expect(assertPublicMediaUrl(url, publicDns)).rejects.toMatchObject({ code });
    });
  }

  it("rejects a public hostname that resolves to a private address", async () => {
    await expect(assertPublicMediaUrl(CDN, async () => ["10.1.2.3"])).rejects.toMatchObject({ code: "private_address" });
    await expect(assertPublicMediaUrl(CDN, async () => ["157.240.1.1", "192.168.0.1"])).rejects.toMatchObject({
      code: "private_address",
    });
  });

  it("fails closed when DNS gives nothing", async () => {
    await expect(assertPublicMediaUrl(CDN, async () => [])).rejects.toMatchObject({ code: "fetch_failed" });
  });

  it("accepts a public https url", async () => {
    const url = await assertPublicMediaUrl(CDN, publicDns);
    expect(url.hostname).toBe("lookaside.fbsbx.com");
  });

  it("describes a url by hostname only (signed tokens stay out of logs)", () => {
    expect(describeMediaUrl(CDN)).toBe("lookaside.fbsbx.com");
    expect(describeMediaUrl("nope")).toBe("invalid-url");
  });
});

describe("fetchAttachment", () => {
  it("downloads, sniffs and returns the buffer", async () => {
    const fetchImpl = fetchReturning(ogg(100), { headers: { "content-type": "audio/ogg; codecs=opus" } });
    const result = await fetchAttachment(CDN, { maxBytes: 1024, fetchImpl, resolveHost: publicDns });
    expect(result.mime).toBe("audio/ogg");
    expect(result.bytes).toBe(100);
    expect(result.declaredContentType).toBe("audio/ogg");
    expect(result.buffer.subarray(0, 4).toString()).toBe("OggS");
    expect(fetchImpl).toHaveBeenCalledWith(CDN, expect.objectContaining({ redirect: "manual", method: "GET" }));
  });

  it("never fetches a private url", async () => {
    const fetchImpl = fetchReturning(ogg());
    await expect(
      fetchAttachment("https://127.0.0.1/voice.ogg", { maxBytes: 1024, fetchImpl, resolveHost: publicDns })
    ).rejects.toMatchObject({ code: "private_address" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects on Content-Length above the cap without reading the body", async () => {
    const fetchImpl = fetchReturning(ogg(100), { headers: { "content-length": "5000000" } });
    await expect(fetchAttachment(CDN, { maxBytes: 1024, fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("aborts a streaming body once it exceeds the cap", async () => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(pulls === 1 ? ogg(512) : Buffer.alloc(512, 1)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = fetchReturning(stream);
    await expect(fetchAttachment(CDN, { maxBytes: 1000, fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({
      code: "too_large",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("rejects an unsupported sniffed type (an HTML error page with an image header)", async () => {
    const fetchImpl = fetchReturning(Buffer.from("<html><body>Access denied</body></html>"), {
      headers: { "content-type": "image/jpeg" },
    });
    await expect(fetchAttachment(CDN, { maxBytes: 1024, fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({
      code: "unsupported_type",
    });
  });

  it("enforces allowedContentTypes (an image on the audio path)", async () => {
    const fetchImpl = fetchReturning(jpeg());
    await expect(
      fetchAttachment(CDN, { maxBytes: 1024, fetchImpl, resolveHost: publicDns, allowedContentTypes: AUDIO_MIME_TYPES })
    ).rejects.toMatchObject({ code: "unsupported_type" });
    await expect(
      fetchAttachment(CDN, { maxBytes: 1024, fetchImpl, resolveHost: publicDns, allowedContentTypes: IMAGE_MIME_TYPES })
    ).resolves.toMatchObject({ mime: "image/jpeg" });
  });

  it("maps HTTP errors to fetch_failed", async () => {
    const fetchImpl = fetchReturning(Buffer.from("gone"), { status: 410 });
    await expect(fetchAttachment(CDN, { maxBytes: 1024, fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({
      code: "fetch_failed",
    });
  });

  it("follows a redirect but re-validates the target", async () => {
    const redirect = new Response(null, { status: 302, headers: { location: "https://scontent.cdninstagram.com/v.ogg" } });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(new Response(ogg() as unknown as BodyInit, { status: 200 }));
    const result = await fetchAttachment(CDN, { maxBytes: 1024, fetchImpl, resolveHost: publicDns });
    expect(result.mime).toBe("audio/ogg");
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://scontent.cdninstagram.com/v.ogg", expect.anything());

    const toPrivate = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://127.0.0.1/secret" } }));
    await expect(fetchAttachment(CDN, { maxBytes: 1024, fetchImpl: toPrivate, resolveHost: publicDns })).rejects.toMatchObject(
      { code: "private_address" }
    );
    expect(toPrivate).toHaveBeenCalledTimes(1);
  });

  it("gives up after too many redirects", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 301, headers: { location: "https://lookaside.fbsbx.com/again" } })
    );
    await expect(fetchAttachment(CDN, { maxBytes: 1024, fetchImpl, resolveHost: publicDns })).rejects.toMatchObject({
      code: "too_many_redirects",
    });
  });

  it("times out", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })
    );
    await expect(
      fetchAttachment(CDN, { maxBytes: 1024, fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: publicDns, timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("wraps network errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const error = await fetchAttachment(CDN, { maxBytes: 1024, fetchImpl, resolveHost: publicDns }).catch((e) => e);
    expect(error).toBeInstanceOf(AttachmentError);
    expect(error.code).toBe("fetch_failed");
  });
});

describe("env caps and helpers", () => {
  it("defaults to 8 MB audio / 5 MB image and reads the env overrides", () => {
    expect(maxAudioBytes()).toBe(8 * 1024 * 1024);
    expect(maxImageBytes()).toBe(5 * 1024 * 1024);
    vi.stubEnv("JAVOBAI_MAX_AUDIO_BYTES", "1000");
    vi.stubEnv("JAVOBAI_MAX_IMAGE_BYTES", "garbage");
    expect(maxAudioBytes()).toBe(1000);
    expect(maxImageBytes()).toBe(5 * 1024 * 1024);
  });

  it("fetchAudioAttachment / fetchImageAttachment apply the caps and types", async () => {
    vi.stubEnv("JAVOBAI_MAX_AUDIO_BYTES", "50");
    await expect(
      fetchAudioAttachment(CDN, { fetchImpl: fetchReturning(ogg(100)), resolveHost: publicDns })
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      fetchImageAttachment(CDN, { fetchImpl: fetchReturning(ogg(100)), resolveHost: publicDns })
    ).rejects.toMatchObject({ code: "unsupported_type" });
    await expect(
      fetchImageAttachment(CDN, { fetchImpl: fetchReturning(jpeg(100)), resolveHost: publicDns })
    ).resolves.toMatchObject({ mime: "image/jpeg", bytes: 100 });
  });
});

describe("per-conversation media cap", () => {
  it("mediaWindowAllows: 3 per 10 minutes, old entries pruned", () => {
    const now = 1_000_000_000;
    expect(mediaWindowAllows([], now)).toEqual({ allowed: true, recent: [] });
    expect(mediaWindowAllows([now - 1000, now - 2000], now).allowed).toBe(true);
    expect(mediaWindowAllows([now - 1000, now - 2000, now - 3000], now).allowed).toBe(false);
    const pruned = mediaWindowAllows([now - 11 * 60_000, now - 1000, now - 2000, now - 3000], now);
    expect(pruned.allowed).toBe(false);
    expect(pruned.recent).toHaveLength(3);
    expect(mediaWindowAllows([now - 11 * 60_000, now - 12 * 60_000, now - 1000], now).allowed).toBe(true);
  });

  it("acquireMediaSlot: one atomic INCR + PEXPIRE script, undo above the cap, fail open on errors", async () => {
    let count = 0;
    const calls: string[] = [];
    const store = {
      eval: async (script: string, numKeys: number, ...args: Array<string | number>) => {
        calls.push(`eval ${numKeys} ${args.join(" ")}`);
        expect(script).toBe(MEDIA_SLOT_SCRIPT);
        return ++count;
      },
      decr: async (key: string) => {
        calls.push(`decr ${key}`);
        return --count;
      },
    };
    expect(await acquireMediaSlot(store, "c1")).toBe(true);
    expect(await acquireMediaSlot(store, "c1")).toBe(true);
    expect(await acquireMediaSlot(store, "c1")).toBe(true);
    expect(await acquireMediaSlot(store, "c1")).toBe(false);
    expect(count).toBe(3);
    // The expiry rides on the same call as the increment: a failed PEXPIRE can never leave a counter without a TTL.
    expect(calls[0]).toBe("eval 1 javobai:media:c1 600000");
    expect(calls.filter((c) => c.startsWith("eval"))).toHaveLength(4);
    expect(calls.at(-1)).toBe("decr javobai:media:c1");
    expect(MEDIA_SLOT_SCRIPT).toMatch(/INCR[\s\S]*n == 1[\s\S]*PEXPIRE/);

    const broken = {
      eval: async () => {
        throw new Error("redis down");
      },
      decr: async () => 0,
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await acquireMediaSlot(broken, "c2")).toBe(true);
    spy.mockRestore();
  });
});
