/** @type {import('next').NextConfig} */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, "..");
const rootPkg = JSON.parse(readFileSync("../package.json", "utf-8"));

const isStaticExport = process.env.STATIC_EXPORT === "1";
if (!isStaticExport) {
  initOpenNextCloudflareForDev();
}

const nextConfig = {
  reactStrictMode: false,
  output: isStaticExport ? "export" : undefined,
  // Monorepo root — outputFileTracingRoot is needed for both Webpack and Turbopack
  // standalone builds (used by opennextjs-cloudflare) to resolve hoisted deps
  // (zustand/middleware, highlight.js/*, styled-jsx/style).
  // See vercel/next.js#88844. Requires post-build step to flatten
  // .next/standalone/web/* → .next/standalone/* for opennextjs-cloudflare.
  // Turbopack disabled — bug vercel/next.js#88844: useContext/useState null on
  // prerender of error/not-found pages under monorepo root.
  outputFileTracingRoot: monorepoRoot,
  // Turbopack infers the monorepo root from the root lockfile and resolves/watches
  // the whole tree (host/, expo/) — pinning to web/ shrinks dev memory (vercel/next.js#94432).
  turbopack: {
    root: __dirname
  },
  experimental: {
    // Dev FS cache is never pruned upstream and gets deserialized into RAM on every
    // boot — unbounded .next/dev growth (vercel/next.js#81161). Proper fix is Next 16.3.
    turbopackFileSystemCacheForDev: false
  },
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
    NEXT_PUBLIC_STATIC_EXPORT: process.env.STATIC_EXPORT || "0",
  },
  ...(isStaticExport ? {} : {
    // Dev-only proxy for host-env UI work (NEXT_PUBLIC_DEV_HOST=1; the legacy
    // NEXT_PUBLIC_DEV_AGENT spelling still works): the host-local APIs live on
    // the host's own server, so the dev server forwards them there — the page
    // stays same-origin from the browser's view.
    // Paths the web app owns itself (/api/version, /api/session, /api/webrtc,
    // ...) are deliberately NOT listed. Never active in production builds.
    ...(process.env.NODE_ENV === "development"
      && (process.env.NEXT_PUBLIC_DEV_HOST === "1" || process.env.NEXT_PUBLIC_DEV_AGENT === "1") ? {
      async rewrites() {
        const hostOrigin = process.env.DEV_HOST_ORIGIN || process.env.DEV_AGENT_ORIGIN || "http://localhost:2208";
        const agentApi = [
          "/api/ui/:path*",
          "/api/key/:path*",
          "/api/autostart",
          "/api/desktop-unlock/:path*",
          "/api/permissions/:path*",
          "/api/permissions",
          "/api/desktop/:path*",
          "/api/remote/enabled",
          "/api/sleep-inhibit",
          "/api/device/:path*",
          "/api/logs/:path*",
          "/api/logs",
          "/api/sessions/:path*",
          "/api/connections"
        ].map((p) => ({ source: p, destination: `${hostOrigin}${p}` }));
        return agentApi;
      },
    } : {}),
    async headers() {
    // Report-Only for now: this reports what it WOULD block and blocks nothing,
    // so a policy that is subtly wrong shows up in the console instead of in a
    // blank page. Switch the header name to Content-Security-Policy once the
    // reports are quiet.
    //
    // What it is for: this origin holds the device-trust tail and the saved
    // keys, and the app renders documents it did not author (spreadsheets,
    // .docx, diffs). If one of those ever runs script again, connect-src is
    // what stops it from posting what it read anywhere.
    const csp = [
      "default-src 'self'",
      // Next inlines its bootstrap and hydration data; nonces would need
      // middleware on every request. unsafe-eval is NOT here — nothing in the
      // app evals, and leaving it out is most of the value of script-src.
      "script-src 'self' 'unsafe-inline'",
      // Tailwind and the theme system write inline styles at runtime.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      // blob: for pasted images and file previews, flagcdn for the language picker.
      "img-src 'self' data: blob: https://flagcdn.com",
      "media-src 'self' blob:",
      // The agent's address is not known ahead of time — a quick tunnel gets a
      // fresh *.trycloudflare.com host on every restart — but the shapes are:
      // that wildcard, this zone, and the LAN, which CSP cannot express as a
      // range. The private ranges are enumerated by first octet instead; it is
      // long, and it is still far narrower than allowing every host.
      [
        "connect-src 'self'",
        "https://*.trycloudflare.com wss://*.trycloudflare.com",
        "https://*.9remote.cc wss://*.9remote.cc",
        "https://api.github.com",
        // 10.0.0.0/8
        "http://10.* ws://10.*",
        // 192.168.0.0/16
        "http://192.168.* ws://192.168.*",
        // 172.16.0.0/12 — CSP has no netmask, so the sixteen /16s are listed.
        ...Array.from({ length: 16 }, (_, i) => `http://172.${16 + i}.* ws://172.${16 + i}.*`),
        // Codespaces forwards the agent over its own domain.
        "https://*.app.github.dev wss://*.app.github.dev"
      ].join(" "),
      // PDFs and HTML previews render from blob: URLs; the sites host holds the
      // browsed local servers, framed by the site browser.
      "frame-src 'self' blob: https://*.9remote.cc http://sites.localhost:3000",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ");

    const securityHeaders = [
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      // camera/microphone=(self): QR login scan and voice dictation run in
      // this origin's own document; camera=() broke getUserMedia on Chrome.
      { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=()" },
      { key: "Content-Security-Policy-Report-Only", value: csp }
    ];
    // The sites shell and its worker, which in production never reach Next at
    // all (the worker branches on hostname first). In `next dev` there is no
    // such branch, so without this the app's own headers apply: X-Frame-Options
    // DENY refuses to be framed, and no Service-Worker-Allowed means the worker
    // cannot claim scope "/". Both are exactly what the feature needs.
    const sitesShellHeaders = [
      { key: "Cache-Control", value: "no-store" },
      { key: "Origin-Agent-Cluster", value: "?1" },
      { key: "Service-Worker-Allowed", value: "/" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'self' http://localhost:3000" }
    ];

    return [
      {
        source: "/_next/static/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }, ...securityHeaders]
      },
      { source: "/proxy.html", headers: sitesShellHeaders },
      { source: "/sw-site.js", headers: sitesShellHeaders },
      {
        // Next appends the headers of every rule that matches rather than
        // letting a later one win, so the catch-all has to exclude the two
        // paths above or X-Frame-Options would come along regardless.
        source: "/:path((?!proxy\\.html$|sw-site\\.js$).*)",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" },
          ...securityHeaders
        ]
      }
    ];
  }
}),
};

export default nextConfig;
