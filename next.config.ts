import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  // The dev server is exposed through a Cloudflare quick tunnel whose
  // hostname changes on every restart. Without this, Next.js blocks the
  // cross-origin webpack-hmr websocket the tunnel origin needs, which left
  // every client component stuck on its initial render (skeletons forever,
  // no hydration) even though the page itself loaded fine.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
