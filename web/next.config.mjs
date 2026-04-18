/** @type {import('next').NextConfig} */
import { readFileSync } from "fs";

const rootPkg = JSON.parse(readFileSync("../package.json", "utf-8"));

// Only attach webpack hook when running `next build --webpack` to avoid
// Turbopack dev warnings. Obfuscator runs only for production client bundle.
const isWebpackBuild = process.argv.includes("build") && process.argv.includes("--webpack");

let obfuscatorPlugin = null;
if (isWebpackBuild) {
  const { default: WebpackObfuscator } = await import("webpack-obfuscator");
  const { browserPreset } = await import("../scripts/obfuscatorConfig.js");
  obfuscatorPlugin = new WebpackObfuscator(browserPreset, ["**/*.min.js"]);
}

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
  ...(isWebpackBuild && {
    webpack(config, { dev, isServer }) {
      if (!dev && !isServer && obfuscatorPlugin) {
        config.plugins.push(obfuscatorPlugin);
      }
      return config;
    },
  }),
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
