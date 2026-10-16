import type { NextConfig } from "next";

// The platform-admin panel lives under /admin in the app, but on its own host
// it is served from the root: admin.socialauto.uz/login, not /admin/login.
const adminHost = [{ type: "host" as const, value: process.env.ADMIN_HOST ?? "admin.socialauto.uz" }];

/**
 * Content-Security-Policy, enforced (not report-only).
 *
 * Next.js emits inline bootstrap scripts and React/Tailwind inject inline
 * styles, so 'unsafe-inline' is required until we move to per-request nonces
 * (proxy.ts + dynamic rendering, see node_modules/next/dist/docs/01-app/02-guides/
 * content-security-policy.md). Fonts come from next/font/google, which
 * self-hosts them at build time, so font-src stays 'self'.
 *
 * To tighten later:
 *  1. img-src: replace `https:` with the exact Meta CDN hosts
 *     (https://*.cdninstagram.com https://*.fbcdn.net) once every avatar/thumbnail
 *     source is known.
 *  2. script-src: drop 'unsafe-inline' and use a nonce set in proxy.ts.
 *  3. style-src: same, with a nonce.
 * 'unsafe-eval' is only added in dev (React debugging needs it).
 */
const isDev = process.env.NODE_ENV !== "production";
export const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const securityHeaders = [
  // No includeSubDomains / preload on purpose: other subdomains (e.g. promtchi) are not
  // verified to be HTTPS-only. See docs/DEPLOY_PLAN_ETAP1-10.md ("HSTS") to enable them later.
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  /* config options here */
  poweredByHeader: false,
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  // Caddy (docker-compose.prod.yml / Caddyfile) compresses every response at
  // the edge — doing it again in the Node process would just burn CPU on the
  // same bytes twice. Vercel's own edge network compresses regardless of this
  // setting, so turning it off here is safe there too.
  compress: false,
  experimental: {
    // Only pulls in the recharts submodules a page actually imports, instead
    // of the whole chart library — recharts has no default tree-shaking.
    optimizePackageImports: ["recharts"],
  },
  // The dev server is exposed through a Cloudflare quick tunnel whose
  // hostname changes on every restart. Without this, Next.js blocks the
  // cross-origin webpack-hmr websocket the tunnel origin needs, which left
  // every client component stuck on its initial render (skeletons forever,
  // no hydration) even though the page itself loaded fine.
  // Icons and the PWA manifest were served with max-age=0, so every page view
  // re-requested them across the ~0.3s round trip to the server. A day of
  // caching (with a week of stale-while-revalidate) is plenty for files that
  // change only on a rebrand.
  async headers() {
    const longCache = [
      { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
    ];
    return [
      // Applies to every route; webhook/MCP/cron endpoints are plain JSON
      // responses so these browser-oriented headers do not affect them.
      { source: "/:path*", headers: securityHeaders },
      { source: "/icon-:size.png", headers: longCache },
      { source: "/apple-touch-icon.png", headers: longCache },
      { source: "/manifest.webmanifest", headers: longCache },
      { source: "/favicon.ico", headers: longCache },
    ];
  },
  async redirects() {
    return [
      // Old /admin/... links (and the app's own redirects) land on the clean URL.
      { source: "/admin/:path*", has: adminHost, destination: "/:path*", permanent: false },
      // The trigger engine moved from /dev/triggers into the developer area.
      { source: "/dev/:path*", destination: "/developer/:path*", permanent: false },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", has: adminHost, destination: "/admin" },
        // Everything except Next internals, the API and files with an extension.
        { source: "/:path((?!_next|api|admin)[^.]+)", has: adminHost, destination: "/admin/:path" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  allowedDevOrigins: ["*.trycloudflare.com", "127.0.0.1"],
};

export default nextConfig;
