import { describe, expect, it } from "vitest";
import nextConfig, { contentSecurityPolicy } from "../next.config";

describe("security headers (next.config)", () => {
  it("disables X-Powered-By", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("applies the hardening headers to every route", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeTruthy();
    const map = new Map(all!.headers.map((h) => [h.key, h.value]));
    expect(map.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(map.get("Strict-Transport-Security")).not.toMatch(/includeSubDomains|preload/);
    expect(map.get("X-Frame-Options")).toBe("DENY");
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(map.get("Permissions-Policy")).toContain("camera=()");
    expect(map.get("Content-Security-Policy")).toBe(contentSecurityPolicy);
  });

  it("CSP is enforced, locks framing/objects and allows image CDNs", () => {
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy).toContain("object-src 'none'");
    expect(contentSecurityPolicy).toMatch(/img-src [^;]*data:[^;]*blob:/);
    expect(contentSecurityPolicy).toContain("script-src 'self' 'unsafe-inline'");
  });

  it("keeps the icon cache rules", async () => {
    const rules = await nextConfig.headers!();
    expect(rules.some((r) => r.source === "/favicon.ico")).toBe(true);
  });
});
