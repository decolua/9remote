/** @type {import('next').NextConfig} */

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
    NEXT_PUBLIC_WORKER_URL: "https://remote.9router.com",
  },
};

export default nextConfig;
