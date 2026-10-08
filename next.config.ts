import type { NextConfig } from "next";

// The platform-admin panel lives under /admin in the app, but on its own host
// it is served from the root: admin.socialauto.uz/login, not /admin/login.
const adminHost = [{ type: "host" as const, value: process.env.ADMIN_HOST ?? "admin.socialauto.uz" }];

const nextConfig: NextConfig = {
  /* config options here */
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
      { source: "/icon-:size.png", headers: longCache },
      { source: "/apple-touch-icon.png", headers: longCache },
      { source: "/manifest.webmanifest", headers: longCache },
      { source: "/favicon.ico", headers: longCache },
    ];
  },
  async redirects() {
    // Old /admin/... links (and the app's own redirects) land on the clean URL.
    return [{ source: "/admin/:path*", has: adminHost, destination: "/:path*", permanent: false }];
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
