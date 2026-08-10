/** @type {import('next').NextConfig} */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, "..");
const rootPkg = JSON.parse(readFileSync("../package.json", "utf-8"));

initOpenNextCloudflareForDev();

const nextConfig = {
  reactStrictMode: false,
  // Monorepo root — outputFileTracingRoot is needed for both Webpack and Turbopack
  // standalone builds (used by opennextjs-cloudflare) to resolve hoisted deps
  // (zustand/middleware, highlight.js/*, styled-jsx/style).
  // See vercel/next.js#88844. Requires post-build step to flatten
  // .next/standalone/web/* → .next/standalone/* for opennextjs-cloudflare.
  // Turbopack disabled — bug vercel/next.js#88844: useContext/useState null on
  // prerender of error/not-found pages under monorepo root.
  outputFileTracingRoot: monorepoRoot,
  images: {
    unoptimized: true
  },
  allowedDevOrigins: [
    "*.trycloudflare.com",
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*"
  ],
  env: {
    NEXT_PUBLIC_WORKER_URL: process.env.NEXT_PUBLIC_WORKER_URL || "https://9remote.cc",
    NEXT_PUBLIC_SERVER_VERSION: rootPkg.version,
  },
  async headers() {
    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
    ];
    return [
      {
        source: "/_next/static/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }, ...securityHeaders]
      },
      {
        source: "/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" },
          ...securityHeaders
        ]
      }
    ];
  },
};

export default nextConfig;
