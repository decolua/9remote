// Browser view (local sites over the transport bus) — shared config

// Browsed sites render on their own origin. Everything the app keeps in web
// storage — the device-trust tail, the saved keys — stays out of reach of a
// script running inside one. The subdomain shares the registrable domain on
// purpose: a cross-site iframe cannot register a service worker once a browser
// blocks third-party cookies, and the whole feature runs on that worker.
const SITES_HOST_BY_APP_HOST = {
  "9remote.cc": "sites.9remote.cc",
  "dev.9remote.cc": "sites-dev.9remote.cc",
  localhost: "sites.localhost",
  // The agent answers on every loopback name, and a page opened on one of them
  // must still get a sites origin. `sites.127.0.0.1` is not a name the browser
  // can resolve — only `*.localhost` is — so both point at the same one.
  "127.0.0.1": "sites.localhost",
  "::1": "sites.localhost"
};

function resolveSitesOrigin(loc) {
  const where = loc || (typeof window === "undefined" ? null : window.location);
  if (!where) return "https://sites.9remote.cc";
  const { hostname, protocol, port } = where;
  const host = SITES_HOST_BY_APP_HOST[hostname];
  // An unknown deploy has no second name to point at. Falling back to this same
  // host would aim the frame at the app's own origin, where nothing serves the
  // shell — a blank frame. A sites name that does not resolve fails just as
  // blank, but it fails as itself rather than silently pointing at the app.
  if (!host) {
    console.warn(`[sites] no sites host is known for ${hostname}; local sites are unavailable here`);
    return null;
  }
  return port ? `${protocol}//${host}:${port}` : `${protocol}//${host}`;
}

export const SITES_ORIGIN = resolveSitesOrigin();
export { resolveSitesOrigin };

export function isSitesOrigin(origin) {
  // "null" is what an opaque origin sends; it must never pass for ours.
  return typeof origin === "string" && origin !== "" && origin !== "null" && origin === SITES_ORIGIN;
}

/**
 * Where the proxy iframe points. Port and path ride in the fragment: it never
 * reaches the server, so the address being browsed stays out of edge logs.
 * Returns null for a port that is not a real one rather than interpolating it.
 */
export function siteProxySrc(port, path, tick = 0) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  // No sites origin on this deploy — an unset src beats "null/proxy.html".
  if (!SITES_ORIGIN) return null;
  // The tick goes in the QUERY, not the fragment: changing only a fragment is a
  // same-document navigation, so the iframe would keep showing the old site
  // instead of reloading. The address itself stays in the fragment, which never
  // reaches the server.
  const q = tick ? `?r=${tick}` : "";
  return `${SITES_ORIGIN}/proxy.html${q}#port=${n}&path=${encodeURIComponent(path || "/")}`;
}

export const SITE_NAV_EVENT = "site-nav";
// Raised when a browsed page could not be served at all (worker blocked, shell
// unreachable). The worker answers the frame with plain text, which renders as a
// bare page — this is how the view learns there is something to explain.
export const SITE_ERROR_EVENT = "site-error";

// Must exceed the SW's own bridge timeout (60s) so the SW surfaces the error first
export const SITE_REPLY_TIMEOUT_MS = 75000;
export const SITES_FETCH_TIMEOUT_MS = 8000;
