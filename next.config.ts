import type { NextConfig } from "next";

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
  allowedDevOrigins: ["*.trycloudflare.com", "127.0.0.1"],
};

export default nextConfig;
