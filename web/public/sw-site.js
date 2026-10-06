// Site proxy service worker: serves /browse/<port|host>/... documents via transport bridge.

importScripts("/swBridgeClaim.js");

const BROWSE_RE = /^\/browse\/([^/]+)(\/.*)?$/;
const PORT_KEY_RE = /^\d{1,5}$/;
const HOST_KEY_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const BRIDGE_TIMEOUT_MS = 60000;
const BRIDGE_DISCOVER_MS = 3000;
const MAX_REQUEST_BODY_BYTES = 512 * 1024;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

// Restrict framing and origin communication via Content Security Policy.
const SITE_CSP = [
  "connect-src 'self'",
  "form-action 'self'",
  `frame-ancestors 'self' ${appOriginsFor(self.location.hostname, self.location.port)}`.trim(),
  "base-uri 'self'"
].join("; ");

let bridgeClient = null;
let bridgeDiscover = null;
let bridgeResolve = null;
let reqCounter = 0;

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "bridge-hello") {
    // Verify source is shell to prevent cross-site privilege escalation.
    if (!canBeBridge(event.source?.url, self.location.origin)) return;
    bridgeClient = event.source;
    if (bridgeResolve) {
      const resolve = bridgeResolve;
      bridgeDiscover = null;
      bridgeResolve = null;
      resolve();
    }
    return;
  }
});

function base64ToBytes(b64) {
  const bin = atob(b64 || "");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function discoverBridge() {
  if (bridgeClient) return Promise.resolve();
  if (!bridgeDiscover) {
    bridgeDiscover = new Promise((resolve) => {
      bridgeResolve = resolve;
      setTimeout(() => {
        bridgeDiscover = null;
        bridgeResolve = null;
        resolve();
      }, BRIDGE_DISCOVER_MS);
    });
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (canBeBridge(client.url, self.location.origin)) client.postMessage({ type: "sw-hello" });
      }
    }).catch(() => {});
  }
  return bridgeDiscover;
}

// A browse scope key: { port } for localhost sites, { host } for public sites.
function siteKeyFromSegment(seg) {
  if (PORT_KEY_RE.test(seg)) return { port: Number(seg) };
  const host = String(seg || "").toLowerCase().replace(/\.$/, "");
  if (host.length <= 253 && HOST_KEY_RE.test(host)) return { host };
  return null;
}

function keySegment(key) {
  return key.host || String(key.port);
}

function keyOrigin(key) {
  return key.host ? `https://${key.host}` : `http://localhost:${key.port}`;
}

// Injected script rewriting links/forms into /browse/<port|host> scope.
function inScopeScript(key) {
  const seg = keySegment(key);
  const absOrigin = keyOrigin(key);
  return `<script data-9remote="site-proxy">
(function () {
  if (window.__nineRemoteSiteProxy) return;
  window.__nineRemoteSiteProxy = true;
  var BASE = "/browse/${seg}";
  var ABS = ${JSON.stringify(absOrigin)};
  var ALT = ABS.indexOf("://www.") !== -1 ? ABS.replace("://www.", "://") : ABS.replace("://", "://www.");
  function scopeUrl(url) {
    if (url.origin === ABS || url.origin === ALT) return BASE + url.pathname;
    if (url.origin !== location.origin) return null;
    if (!url.pathname || url.pathname.indexOf(BASE + "/") === 0 || url.pathname === BASE) return null;
    return url.pathname.charAt(0) === "/" ? BASE + url.pathname : null;
  }
  // Bubble phase allows SPA routers to handle owned routes first.
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a || a.target && a.target !== "_self" || a.hasAttribute("download")) return;
    var url;
    try { url = new URL(a.getAttribute("href"), location.href); } catch (err) { return; }
    var next = scopeUrl(url);
    if (!next) return;
    e.preventDefault();
    location.replace(next + url.search + url.hash);
  });
  document.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!form || form.tagName !== "FORM" || form.target && form.target !== "_self") return;
    var action = form.getAttribute("action");
    if (action === null) return;
    var url;
    try { url = new URL(action, location.href); } catch (err) { return; }
    var next = scopeUrl(url);
    if (next) form.setAttribute("action", next + url.search);
  }, true);
  var nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    var action = this.getAttribute("action");
    if (action !== null) {
      try {
        var url = new URL(action, location.href);
        var next = scopeUrl(url);
        if (next) this.setAttribute("action", next + url.search);
      } catch (err) {}
    }
    return nativeSubmit.call(this);
  };
  // Downgrade pushState to replaceState so iframe history doesn't swallow parent Back.
  var nativeReplace = history.replaceState.bind(history);
  ["pushState", "replaceState"].forEach(function (name) {
    history[name] = function (state, title, path) {
      if (typeof path === "string") {
        try {
          var url = new URL(path, location.href);
          var next = scopeUrl(url);
          if (next) path = next + url.search + url.hash;
        } catch (err) { /* leave path as-is */ }
      }
      return nativeReplace(state, title, path);
    };
  });
})();
</script>`;
}

function injectIntoHtml(html, key) {
  const tag = inScopeScript(key);
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], () => head[0] + tag);
  return tag + html;
}

function extractSiteKey(rawUrl) {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    const m = u.pathname.match(BROWSE_RE);
    if (m) return siteKeyFromSegment(m[1]);
    if (u.hash) {
      const h = new URLSearchParams(u.hash.replace(/^#/, ""));
      const host = h.get("host");
      if (host) return siteKeyFromSegment(host);
      const port = h.get("port");
      if (port) return siteKeyFromSegment(port);
    }
  } catch { /* ignore */ }
  return null;
}

async function siteFromReferrer(request, clientId) {
  try {
    if (request.referrer) {
      const key = extractSiteKey(request.referrer);
      if (key) return key;
    }
  } catch { /* fall through */ }

  if (clientId) {
    try {
      const client = await self.clients.get(clientId);
      if (client?.url) {
        const key = extractSiteKey(client.url);
        if (key) return key;
      }
    } catch { /* ignore */ }
  }

  try {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      const key = extractSiteKey(client.url);
      if (key) return key;
    }
  } catch { /* ignore */ }
  return null;
}

// MessageChannel per request to keep concurrent requests isolated.
function requestViaBridge(reqId, key, method, target, headers, bodyB64) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error("bridge-timeout"));
    }, BRIDGE_TIMEOUT_MS);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data);
    };
    bridgeClient.postMessage(
      { type: "http-request", reqId, ...key, method, target, headers, bodyB64 },
      [channel.port2]
    );
  });
}

function fail(message, status, key) {
  if (key) {
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (canBeBridge(client.url, self.location.origin)) client.postMessage({ type: "site-error", message, ...key });
      }
    }).catch(() => {});
  }
  return new Response(`9Remote: ${message}`, { status });
}

function sameKey(a, b) {
  return !!a && !!b && a.port === b.port && a.host === b.host;
}

function scopedRedirect(targetPath, status = 302) {
  const absUrl = new URL(targetPath, self.location.origin).href;
  return Response.redirect(absUrl, status);
}

async function handle(request, url, inScope, clientId) {
  const key = inScope ? siteKeyFromSegment(inScope[1]) : await siteFromReferrer(request, clientId);
  if (!key) return fail("no site context for this request", 503, null);

  // Prevent cross-site subresource access within shared origin.
  if (inScope && request.mode !== "navigate") {
    const from = await siteFromReferrer(request, clientId);
    if (from && !sameKey(from, key)) {
      return new Response("9Remote: cross-site request refused", { status: 403 });
    }
  }

  await discoverBridge();
  if (!bridgeClient) return fail("bridge not connected — open the 9Remote app", 503, key);

  url.searchParams.delete("r");
  const path = inScope ? (inScope[2] || "/") : url.pathname;
  const target = path + (url.search || "");

  if (request.mode === "navigate") {
    bridgeClient.postMessage({ type: "site-nav", ...key, path });
  }

  const headers = {};
  request.headers.forEach((value, key2) => {
    if (key2.toLowerCase() !== "cookie") headers[key2] = value;
  });

  let bodyB64 = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_REQUEST_BODY_BYTES) {
      return new Response("9Remote: request body too large", { status: 413 });
    }
    if (buf.byteLength > 0) bodyB64 = bytesToBase64(buf);
  }

  const reqId = `sw-${Date.now()}-${++reqCounter}`;
  let msg;
  try {
    msg = await requestViaBridge(reqId, key, request.method, target, headers, bodyB64);
  } catch {
    return fail("request timed out", 504, key);
  }
  if (!msg || msg.error) return fail(msg?.error || "no reply from the agent", 502, key);

  const resHeaders = new Headers(msg.headers || {});

  const location = resHeaders.get("location");
  if (location && REDIRECT_STATUSES.includes(msg.status)) {
    let next = null;
    let crossHost = null;
    let crossPath = "";
    try {
      const abs = new URL(location, keyOrigin(key));
      if (location.startsWith("/") || abs.origin === keyOrigin(key)) next = abs.pathname + abs.search;
      // Cross-host redirects (example.com -> www.example.com) hop to their own scope.
      else if (key.host && abs.protocol === "https:") {
        crossHost = abs.hostname.toLowerCase();
        crossPath = abs.pathname + abs.search;
      }
    } catch { /* keep null */ }
    if (next) return scopedRedirect(`/browse/${keySegment(key)}${next}`, msg.status);
    if (crossHost) return scopedRedirect(`/browse/${crossHost}${crossPath}`, msg.status);
    return scopedRedirect(location, msg.status);
  }

  if (msg.status === 204 || msg.status === 304) {
    return new Response(null, { status: msg.status, headers: resHeaders });
  }

  // Enforce CSP on proxied site content.
  resHeaders.set("Content-Security-Policy", SITE_CSP);

  const bytes = base64ToBytes(msg.bodyB64);
  if ((resHeaders.get("content-type") || "").includes("text/html")) {
    const html = new TextDecoder("utf-8").decode(bytes);
    return new Response(injectIntoHtml(html, key), { status: msg.status, headers: resHeaders });
  }
  return new Response(bytes, { status: msg.status, headers: resHeaders });
}

// A navigation the page started outside /browse/ (window.location.href =
// "/dashboard", form submit, meta refresh, window.open).
async function scopeEscape(request, url, clientId) {
  const key = await siteFromReferrer(request, clientId);
  if (key) {
    const target = `/browse/${keySegment(key)}${url.pathname}${url.search}`;
    return scopedRedirect(target, 302);
  }
  return fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  let url;
  try { url = new URL(request.url); } catch { return; }

  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw-site.js") return;
  if (url.pathname === "/proxy.html") return;
  if (url.pathname.startsWith("/cdn-cgi/")) return;

  const inScope = url.pathname.match(BROWSE_RE);
  if (inScope) {
    event.respondWith(handle(request, url, inScope, event.clientId));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(scopeEscape(request, url, event.clientId));
    return;
  }
  // Root-relative subresource requests from in-scope pages.
  event.respondWith(handle(request, url, null, event.clientId));
});
