/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
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
