/** @type {import('next').NextConfig} */
import { readFileSync } from "fs";

// Read version from root package.json
const rootPkg = JSON.parse(readFileSync("../package.json", "utf-8"));

// Check if building for npm package (standalone) or worker (export)
const isStandalone = process.env.BUILD_STANDALONE === "true";

const nextConfig = {
  output: isStandalone ? "standalone" : "export",
  reactStrictMode: false,
  trailingSlash: true,
  images: {
    unoptimized: true
  },
  // Allow Cloudflare tunnel domains in development
  allowedDevOrigins: [
    "*.trycloudflare.com"
  ],
  env: {
    NEXT_PUBLIC_WORKER_URL: "https://9remote.cc",
    NEXT_PUBLIC_SERVER_VERSION: rootPkg.version,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
          }
        ]
      }
    ];
  },
};

export default nextConfig;
