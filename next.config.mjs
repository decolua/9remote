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
  ]
};

export default nextConfig;
