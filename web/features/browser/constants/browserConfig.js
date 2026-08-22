// Browser view (local sites over the transport bus) — shared config

// Browsed sites render on their own origin. Everything the app keeps in web
// storage — the device-trust tail, the saved keys — stays out of reach of a
// script running inside one. The subdomain shares the registrable domain on
// purpose: a cross-site iframe cannot register a service worker once a browser
// blocks third-party cookies, and the whole feature runs on that worker.
const SITES_HOST_BY_APP_HOST = {
  "9remote.cc": "sites.9remote.cc",
  "dev.9remote.cc": "sites-dev.9remote.cc",
  localhost: "sites.localhost"
};

function resolveSitesOrigin() {
  if (typeof window === "undefined") return "https://sites.9remote.cc";
  const { hostname, protocol, port } = window.location;
  const host = SITES_HOST_BY_APP_HOST[hostname];
  if (!host) return `${protocol}//${hostname}`; // unknown deploy — stay put
  return port ? `${protocol}//${host}:${port}` : `${protocol}//${host}`;
}

export const SITES_ORIGIN = resolveSitesOrigin();

export function isSitesOrigin(origin) {
  // "null" is what an opaque origin sends; it must never pass for ours.
  return typeof origin === "string" && origin !== "" && origin !== "null" && origin === SITES_ORIGIN;
}

/**
 * Where the proxy iframe points. Port and path ride in the fragment: it never
 * reaches the server, so the address being browsed stays out of edge logs.
 * Returns null for a port that is not a real one rather than interpolating it.
 */
export function siteProxySrc(port, path) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return `${SITES_ORIGIN}/proxy.html#port=${n}&path=${encodeURIComponent(path || "/")}`;
}

export const SITE_NAV_EVENT = "site-nav";

// Must exceed the SW's own bridge timeout (60s) so the SW surfaces the error first
export const SITE_REPLY_TIMEOUT_MS = 75000;
export const SITES_FETCH_TIMEOUT_MS = 8000;
