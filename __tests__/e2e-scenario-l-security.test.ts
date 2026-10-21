/**
 * Scenario L (security + responsive guard):
 *  (a) next.config response headers (extends security-headers.test.ts);
 *  (b) deploy config: server version hidden (Caddy / nginx files that are versioned);
 *  (c) /api/mcp and EVERY route under app/api/developer answer 401/403/404 (never 200/500)
 *      without a token / session - routes are discovered on disk, handlers called for real;
 *  (d) static responsive guard on /developer/comments/new and developer-shell.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({ developerSession: vi.fn(), workspaceContext: vi.fn(), authGetSession: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));
vi.mock("../lib/developer/auth", () => ({ getDeveloperSession: mocks.developerSession }));
vi.mock("../lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.workspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import nextConfig, { contentSecurityPolicy } from "../next.config";
import { handleMcpPost } from "../lib/mcp/http";
import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";

const ROOT = path.resolve(__dirname, "..");

// ───────────────────────────── (a) headers ─────────────────────────────

describe("L(a): next.config security headers", () => {
  async function headerMap() {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeTruthy();
    return new Map(all!.headers.map((h) => [h.key, h.value]));
  }

  it("HSTS max-age is at least one year", async () => {
    const hsts = (await headerMap()).get("Strict-Transport-Security")!;
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(365 * 24 * 3600);
  });

  it("has CSP, X-Frame-Options DENY, nosniff, strict-origin-when-cross-origin and no X-Powered-By", async () => {
    const map = await headerMap();
    expect(map.get("Content-Security-Policy")).toBe(contentSecurityPolicy);
    expect(map.get("X-Frame-Options")).toBe("DENY");
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("CSP has no wildcard default, no remote script hosts and blocks base-uri / form hijack", () => {
    const directive = (name: string) => contentSecurityPolicy.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("script-src")).not.toMatch(/https?:|\*/);
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(directive("base-uri")).toContain("'self'");
    expect(directive("form-action")).toContain("'self'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("no more specific header rule weakens the global ones for developer / api paths", async () => {
    const rules = await nextConfig.headers!();
    for (const rule of rules) {
      for (const h of rule.headers) {
        if (["X-Frame-Options", "Content-Security-Policy", "Strict-Transport-Security"].includes(h.key)) {
          expect(rule.source, `${h.key} is overridden for ${rule.source}`).toBe("/:path*");
        }
      }
    }
  });
});

// ───────────────────────────── (b) deploy config ─────────────────────────────

describe("L(b): deploy config hides the server version", () => {
  const caddyfile = readFileSync(path.join(ROOT, "Caddyfile"), "utf8");
  const nginxDir = path.join(ROOT, "deploy", "nginx");
  const nginxFiles = existsSync(nginxDir) ? readdirSync(nginxDir).filter((f) => f.endsWith(".conf")) : [];
  const nginxText = nginxFiles.map((f) => readFileSync(path.join(nginxDir, f), "utf8")).join("\n");

  it("Caddy (docker-compose.prod.yml): no version string is emitted by the Caddyfile", () => {
    // Caddy sends only `Server: Caddy` (no version) by default; the file must not add one.
    expect(caddyfile).not.toMatch(/header\s+(?:@\w+\s+)?\+?Server\s+\S*\d/i);
    expect(caddyfile).not.toMatch(/X-Powered-By/i);
  });

  it("states which nginx files are versioned (informational): site conf for admin host + gzip conf only", () => {
    expect(nginxFiles.sort()).toEqual(["admin.socialauto.uz.conf", "gzip.conf"]);
    // there is no versioned main nginx.conf and no server block for socialauto.uz itself
    expect(existsSync(path.join(nginxDir, "nginx.conf"))).toBe(false);
  });

  it("the versioned nginx config does not leak the version through proxied responses", () => {
    expect(nginxText).not.toMatch(/proxy_pass_header\s+Server/i);
    expect(nginxText).not.toMatch(/add_header\s+Server/i);
  });

  // GAP: nginx prints `Server: nginx/x.y.z` unless `server_tokens off;` is set, and no versioned
  // nginx file sets it (conf.d/gzip.conf is included in the http{} context and would be the natural place).
  // `it.fails` keeps the real assertion: it turns red (prompting removal of `.fails`) once the directive is added.
  it("nginx config sets `server_tokens off;`", () => {
    expect(nginxText).toMatch(/^\s*server_tokens\s+off\s*;/m);
  });
});

// ───────────────────────────── (c) unauthenticated access ─────────────────────────────

function walkRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkRoutes(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const developerRoutes = walkRoutes(path.join(ROOT, "app", "api", "developer")).sort();
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** params whose every key is a plain string, so `await params` + destructuring works for any route. */
const anyParams = () => Promise.resolve(new Proxy({}, { get: (_t, key) => (typeof key === "string" && key !== "then" ? "x" : undefined) }));

function request(method: string, url: string): NextRequest {
  const withBody = method !== "GET" && method !== "DELETE";
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: withBody ? JSON.stringify({ name: "x", mode: "ADVANCED" }) : undefined,
  });
}

describe("L(c): /api/developer/** without a session", () => {
  beforeEach(() => {
    resetDb();
    mocks.developerSession.mockReset();
    mocks.workspaceContext.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("finds the route files on disk", () => {
    expect(developerRoutes.length).toBeGreaterThan(150);
  });

  async function sweep(label: string, allowed: number[]) {
    const offenders: string[] = [];
    let handlers = 0;
    for (const file of developerRoutes) {
      let mod: Record<string, unknown>;
      try {
        mod = (await import(/* @vite-ignore */ pathToImport(file))) as Record<string, unknown>;
      } catch (error) {
        offenders.push(`${rel(file)}: import failed (${error instanceof Error ? error.message.slice(0, 80) : "?"})`);
        continue;
      }
      for (const method of METHODS) {
        const handler = mod[method];
        if (typeof handler !== "function") continue;
        handlers += 1;
        try {
          const res = (await (handler as (r: NextRequest, c: { params: Promise<unknown> }) => Promise<Response> | Response)(
            request(method, `http://localhost/${rel(file).replace(/^app\//, "").replace(/\/route\.ts$/, "")}`),
            { params: anyParams() }
          )) as Response;
          if (!allowed.includes(res.status)) offenders.push(`${method} ${rel(file)} -> ${res.status}`);
        } catch (error) {
          offenders.push(`${method} ${rel(file)} -> threw ${error instanceof Error ? error.message.slice(0, 80) : "?"}`);
        }
      }
    }
    expect(handlers, `${label}: handlers exercised`).toBeGreaterThan(200);
    expect(offenders, `${label} offenders:\n${offenders.join("\n")}`).toEqual([]);
  }

  it("no developer login -> every exported handler answers 404 (looks non-existent)", async () => {
    mocks.developerSession.mockResolvedValue(null);
    mocks.workspaceContext.mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "OWNER" }); // even with an app session
    await sweep("no developer session", [404]);
  }, 120_000);

  it("developer login but no app session -> every handler answers 401/403/404", async () => {
    mocks.developerSession.mockResolvedValue({ ok: true });
    mocks.workspaceContext.mockResolvedValue(null);
    await sweep("no app session", [401, 403, 404]);
  }, 120_000);
});

function pathToImport(file: string): string {
  return file.split(path.sep).join("/");
}

describe("L(c): /api/mcp without a token", () => {
  let mcp: typeof import("../app/api/mcp/route");

  beforeEach(async () => {
    resetDb();
    resetMcpRateLimitsForTests();
    mcp = await import("../app/api/mcp/route");
  });

  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const post = (headers: Record<string, string> = {}) =>
    mcp.POST(new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: ping }));

  it("POST without Authorization -> 401 with WWW-Authenticate, no data", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(JSON.stringify(await res.json())).not.toMatch(/"result"/);
  });

  it("POST with a wrong / malformed / non-bearer token -> 401, never 200 or 500", async () => {
    for (const header of ["Bearer sa_mcp_nope", "Bearer", "Basic abc", "Bearer a b", "sa_mcp_x", `Bearer ${"x".repeat(500)}`, "Bearer '; DROP TABLE mcp_token;--"]) {
      const res = await post({ authorization: header });
      expect([401, 403, 429], `${header.slice(0, 30)} -> ${res.status}`).toContain(res.status);
    }
  });

  it("GET and DELETE are 405 (no tool surface without POST + token)", async () => {
    expect((await mcp.GET()).status).toBe(405);
    expect((await mcp.DELETE()).status).toBe(405);
  });

  it("an unauthenticated POST with a huge declared body is refused before parsing (413) or as 401, not 200/500", async () => {
    const res = await mcp.POST(
      new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json", "content-length": String(50 * 1024 * 1024) }, body: ping })
    );
    expect([401, 413]).toContain(res.status);
  });

  it("handleMcpPost directly: no token -> 401", async () => {
    const res = await handleMcpPost(new Request("http://localhost/api/mcp", { method: "POST", body: ping }));
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────── (d) responsive guard ─────────────────────────────

const MAX_MOBILE_PX = 375;
const RESPONSIVE_PREFIX = /^(sm|md|lg|xl|2xl):/;

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const candidate of [base + ".tsx", base + ".ts", path.join(base, "index.tsx"), path.join(base, "index.ts"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The page plus every local component / module it (transitively) imports from app/ or components/. */
function componentTree(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const resolved = resolveImport(file, m[1]);
      if (!resolved) continue;
      const r = rel(resolved);
      if (/^(components|app)\//.test(r) && /\.tsx?$/.test(r)) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

/** Width in px of a Tailwind width utility, or null when it is not a fixed width. */
function fixedWidthPx(utility: string): number | null {
  const m = /^(?:min-)?w-(?:\[(\d+(?:\.\d+)?)(px|rem)\]|(\d+(?:\.\d+)?))$/.exec(utility);
  if (!m) return null;
  if (m[1]) return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
  return Number(m[3]) * 4; // spacing scale: 1 unit = 4px (w-96 = 384px)
}

function fixedWidthOffenders(files: string[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const token of line.split(/[\s"'`{}]+/)) {
        if (!token || RESPONSIVE_PREFIX.test(token)) continue;
        // variants such as hover: / focus: / dark: do not make the width responsive
        const utility = token.replace(/^(?:[a-z-]+:)+/, "");
        if (/^(sm|md|lg|xl|2xl):/.test(token)) continue;
        const px = fixedWidthPx(utility);
        if (px !== null && px > MAX_MOBILE_PX) offenders.push(`${rel(file)}:${i + 1}  ${token}  (${px}px)`);
      }
    });
  }
  return offenders;
}

describe("L(d): responsive guard (no fixed width > 375px without a responsive prefix)", () => {
  const entries = [
    path.join(ROOT, "app/developer/(secure)/comments/new/page.tsx"),
    path.join(ROOT, "components/developer/developer-shell.tsx"),
  ];

  it("the scanner resolves the comment builder tree and the shell", () => {
    const tree = componentTree(entries).map(rel);
    expect(tree).toContain("components/developer/comments/comment-builder.tsx");
    expect(tree).toContain("components/developer/developer-shell.tsx");
    expect(tree).toContain("components/developer/ui.tsx");
    expect(tree.length).toBeGreaterThan(8);
  });

  it("the scanner recognises offenders (self-check)", () => {
    expect(fixedWidthPx("w-[480px]")).toBe(480);
    expect(fixedWidthPx("min-w-[28rem]")).toBe(448);
    expect(fixedWidthPx("w-96")).toBe(384);
    expect(fixedWidthPx("max-w-[640px]")).toBeNull();
    expect(fixedWidthPx("w-[320px]")).toBe(320);
  });

  it("/developer/comments/new tree and developer-shell have no fixed width above 375px", () => {
    const tree = componentTree(entries);
    const offenders = fixedWidthOffenders(tree);
    expect(offenders, `Fixed widths > ${MAX_MOBILE_PX}px without sm:/md:/lg: prefix:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("inline style widths in that tree are percentages / computed, not fixed pixel literals above 375", () => {
    const bad: string[] = [];
    for (const file of componentTree(entries)) {
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          const m = /style=\{\{[^}]*\b(?:min)?[wW]idth:\s*(\d{3,5})\b/.exec(line);
          if (m && Number(m[1]) > MAX_MOBILE_PX) bad.push(`${rel(file)}:${i + 1}  ${m[0]}`);
        });
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("the shell keeps horizontal overflow handling (main content scrolls instead of widening the page)", () => {
    const shell = readFileSync(path.join(ROOT, "components/developer/developer-shell.tsx"), "utf8");
    expect(shell).toMatch(/overflow-(x-)?(auto|hidden)|min-w-0|max-w-full|flex-wrap/);
  });
});
