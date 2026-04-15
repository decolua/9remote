import dns from "dns";

// Bypass broken macOS system DNS resolver for long hostnames (e.g. trycloudflare)
const _originalLookup = dns.lookup;
dns.lookup = (hostname, options, cb) => {
  if (typeof options === "function") { cb = options; options = {}; }
  dns.resolve4(hostname, (err, addrs) => {
    if (err) return _originalLookup(hostname, options, cb);
    if (options.all) {
      cb(null, addrs.map(a => ({ address: a, family: 4 })));
    } else {
      cb(null, addrs[0], 4);
    }
  });
};

/**
 * Shared constants for agent server + CLI
 */

// Connection step states (UI progress tracking)
export const STEP = {
  STOPPED: 0,
  PREPARING: 1,
  CONNECTING: 2,
  TUNNELING: 3,
  VERIFYING: 4,
  READY: 5,
};

// Browser-like headers to avoid CDN/firewall blocks
const BROWSER_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

/**
 * fetch() wrapper with browser-like headers for external requests
 */
export function browserFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...BROWSER_HEADERS, ...options.headers },
  });
}
