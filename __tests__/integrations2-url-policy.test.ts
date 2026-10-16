/** ETAP 8 outbound URL policy with an injected resolver (no DNS in tests). */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOutboundUrl,
  hostMatches,
  presetHint,
  readAllowHosts,
  readDenyHosts,
  type HostResolver,
} from "../lib/integrations2/url-policy";

afterEach(() => vi.unstubAllEnvs());

const publicDns: HostResolver = async () => ["93.184.216.34"];
const opts = { resolve: publicDns, allowHosts: [], denyHosts: [] };

describe("assertOutboundUrl", () => {
  it("accepts a public https url", async () => {
    const resolve = vi.fn(publicDns);
    const result = await assertOutboundUrl("https://hooks.example.com/in/abc", { ...opts, resolve });
    expect(result).toEqual({ ok: true, host: "hooks.example.com", url: "https://hooks.example.com/in/abc", allowlisted: false });
    expect(resolve).toHaveBeenCalledWith("hooks.example.com");
    expect((await assertOutboundUrl("https://hooks.example.com:8443/x", opts)).ok).toBe(true);
    expect((await assertOutboundUrl("https://hooks.example.com:443/x", opts)).ok).toBe(true);
  });

  it("rejects by code with an Uzbek reason", async () => {
    const codeOf = async (url: string, o = opts) => {
      const r = await assertOutboundUrl(url, o);
      return r.ok ? "ok" : r.code;
    };
    expect(await codeOf("not a url")).toBe("invalid_url");
    expect(await codeOf("http://hooks.example.com/x")).toBe("scheme");
    expect(await codeOf("ftp://hooks.example.com/x")).toBe("scheme");
    expect(await codeOf("https://user:pw@hooks.example.com/x")).toBe("userinfo");
    expect(await codeOf("https://user@hooks.example.com/x")).toBe("userinfo");
    expect(await codeOf("https://hooks.example.com:8080/x")).toBe("port");
    expect(await codeOf("https://localhost/x")).toBe("internal_host");
    expect(await codeOf("https://api.internal/x")).toBe("internal_host");
    expect(await codeOf("https://intranet/x")).toBe("internal_host");
    expect(await codeOf("https://127.0.0.1/x")).toBe("internal_host");
    expect(await codeOf("https://10.0.0.5/x")).toBe("internal_host");
    expect(await codeOf("https://[::1]/x")).toBe("internal_host");
    expect(await codeOf("https://[::ffff:10.0.0.5]/x")).toBe("internal_host");
    const r = await assertOutboundUrl("http://x.example.com", opts);
    expect(r).toMatchObject({ ok: false, code: "scheme", reason: "Faqat https:// manzillar qabul qilinadi", host: "x.example.com" });
  });

  it("refuses hosts that resolve to private / mapped addresses, or do not resolve", async () => {
    const codeOf = async (resolve: HostResolver) => {
      const r = await assertOutboundUrl("https://evil.example.com/x", { ...opts, resolve });
      return r.ok ? "ok" : r.code;
    };
    expect(await codeOf(async () => ["10.1.2.3"])).toBe("private_address");
    expect(await codeOf(async () => ["93.184.216.34", "192.168.1.1"])).toBe("private_address");
    expect(await codeOf(async () => ["::ffff:127.0.0.1"])).toBe("private_address");
    expect(await codeOf(async () => ["64:ff9b::a00:1"])).toBe("private_address");
    expect(await codeOf(async () => ["fd00::1"])).toBe("private_address");
    expect(await codeOf(async () => ["169.254.169.254"])).toBe("private_address");
    expect(await codeOf(async () => [])).toBe("unresolvable");
    expect(await codeOf(async () => { throw new Error("ENOTFOUND"); })).toBe("unresolvable");
    expect(await codeOf(async () => ["2606:2800:220:1:248:1893:25c8:1946"])).toBe("ok");
  });

  it("public IP literals skip DNS", async () => {
    const resolve = vi.fn(publicDns);
    expect((await assertOutboundUrl("https://93.184.216.34/x", { ...opts, resolve })).ok).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("allow list bypasses port / internal / DNS checks; deny list wins", async () => {
    const resolve = vi.fn(async () => ["10.0.0.9"]);
    const allowed = await assertOutboundUrl("https://n8n.lan.example.com:5678/hook", { resolve, allowHosts: [".lan.example.com"], denyHosts: [] });
    expect(allowed).toMatchObject({ ok: true, allowlisted: true, host: "n8n.lan.example.com" });
    expect(resolve).not.toHaveBeenCalled();
    expect((await assertOutboundUrl("https://localhost:3000/hook", { resolve, allowHosts: ["localhost"], denyHosts: [] })).ok).toBe(true);
    expect((await assertOutboundUrl("http://localhost/hook", { resolve, allowHosts: ["localhost"], denyHosts: [] })).ok).toBe(false);
    const denied = await assertOutboundUrl("https://bad.example.com/x", { resolve: publicDns, allowHosts: ["bad.example.com"], denyHosts: ["*.example.com"] });
    expect(denied).toMatchObject({ ok: false, code: "denied_host" });
  });

  it("reads the lists from env by default", async () => {
    vi.stubEnv("OUTBOUND_WEBHOOK_ALLOW_HOSTS", " Hooks.Internal , .corp.example.com");
    vi.stubEnv("OUTBOUND_WEBHOOK_DENY_HOSTS", "spam.example.com");
    expect(readAllowHosts()).toEqual(["hooks.internal", ".corp.example.com"]);
    expect(readDenyHosts()).toEqual(["spam.example.com"]);
    expect((await assertOutboundUrl("https://hooks.internal/x", { resolve: publicDns })).ok).toBe(true);
    expect((await assertOutboundUrl("https://spam.example.com/x", { resolve: publicDns })).ok).toBe(false);
    vi.stubEnv("OUTBOUND_WEBHOOK_ALLOW_HOSTS", "");
    expect(readAllowHosts()).toEqual([]);
  });

  it("hostMatches: exact, suffix, wildcard", () => {
    expect(hostMatches("a.example.com", "example.com")).toBe(false);
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("a.example.com", ".example.com")).toBe(true);
    expect(hostMatches("example.com", ".example.com")).toBe(true);
    expect(hostMatches("a.b.example.com", "*.example.com")).toBe(true);
    expect(hostMatches("notexample.com", ".example.com")).toBe(false);
    expect(hostMatches("x", "")).toBe(false);
  });
});

describe("presetHint", () => {
  it("warns on shapes that do not look like the preset", () => {
    expect(presetHint("https://hook.eu1.make.com/abcdefghijklmnop", "MAKE")).toBeNull();
    expect(presetHint("https://hook.make.com/abcdefghijklmnop", "MAKE")).toBeNull();
    expect(presetHint("https://hooks.zapier.com/hooks/catch/123/abc/", "MAKE")).toMatch(/hook\.eu1\.make\.com/);
    expect(presetHint("https://hook.eu1.make.com/ab", "MAKE")).toMatch(/token/);
    expect(presetHint("https://hooks.zapier.com/hooks/catch/123456/abcdef/", "ZAPIER")).toBeNull();
    expect(presetHint("https://hooks.zapier.com/hooks/catch/123456/abcdef", "ZAPIER")).toBeNull();
    expect(presetHint("https://zapier.com/app/dashboard", "ZAPIER")).toMatch(/hooks\.zapier\.com/);
    expect(presetHint("https://hooks.zapier.com/other/path", "ZAPIER")).toMatch(/\/hooks\/catch\//);
    expect(presetHint("https://hook.us1.make.com/abcdefghijklmnop", "WEBHOOK")).toMatch(/Make/);
    expect(presetHint("https://hooks.zapier.com/hooks/catch/1/a/", "WEBHOOK")).toMatch(/Zapier/);
    expect(presetHint("https://hooks.example.com/x", "WEBHOOK")).toBeNull();
    expect(presetHint("garbage", "MAKE")).toBeNull();
  });
});
