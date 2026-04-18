/** @type {import('next').NextConfig} */
import { readFileSync } from "fs";

const rootPkg = JSON.parse(readFileSync("../package.json", "utf-8"));

const nextConfig = {
  reactStrictMode: false,
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
