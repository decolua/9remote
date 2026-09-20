// Site proxy service worker: serves /browse/<port>/... documents via transport bridge.

importScripts("/swBridgeClaim.js");

const BROWSE_RE = /^\/browse\/(\d{1,5})(\/.*)?$/;
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

// Injected script rewriting absolute links/forms into /browse/<port> scope.
function inScopeScript(port) {
  return `<script data-9remote="site-proxy">
(function () {
  if (window.__nineRemoteSiteProxy) return;
  window.__nineRemoteSiteProxy = true;
  var BASE = "/browse/${port}";
  function scoped(path) {
    if (!path || path.indexOf(BASE + "/") === 0 || path === BASE) return null;
    return path.charAt(0) === "/" ? BASE + path : null;
  }
  // Bubble phase allows SPA routers to handle owned routes first.
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest("a[href]");
    if (!a || a.target && a.target !== "_self" || a.hasAttribute("download")) return;
    var url;
    try { url = new URL(a.getAttribute("href"), location.href); } catch (err) { return; }
    if (url.origin !== location.origin) return;
    var next = scoped(url.pathname);
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
    if (url.origin !== location.origin) return;
    var next = scoped(url.pathname);
    if (next) form.setAttribute("action", next + url.search);
  }, true);
  // Downgrade pushState to replaceState so iframe history doesn't swallow parent Back.
  var nativeReplace = history.replaceState.bind(history);
  ["pushState", "replaceState"].forEach(function (name) {
    history[name] = function (state, title, path) {
      if (typeof path === "string") {
        try {
          var url = new URL(path, location.href);
          if (url.origin === location.origin) {
            var next = scoped(url.pathname);
            if (next) path = next + url.search + url.hash;
          }
        } catch (err) { /* leave path as-is */ }
      }
      return nativeReplace(state, title, path);
    };
  });
})();
</script>`;
}

function injectIntoHtml(html, port) {
  const tag = inScopeScript(port);
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], () => head[0] + tag);
  return tag + html;
}

async function portFromReferrer(request) {
  try {
    if (request.referrer) {
      const match = new URL(request.referrer).pathname.match(BROWSE_RE);
      if (match) return Number(match[1]);
    }
  } catch { /* bad referrer — fall through */ }
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: false });
  for (const client of clients) {
    const match = new URL(client.url).pathname.match(BROWSE_RE);
    if (match) return Number(match[1]);
  }
  return null;
}

// MessageChannel per request to keep concurrent requests isolated.
function requestViaBridge(reqId, port, method, target, headers, bodyB64) {
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
      { type: "http-request", reqId, port, method, target, headers, bodyB64 },
      [channel.port2]
    );
  });
}

function fail(message, status, port) {
  if (port) {
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (canBeBridge(client.url, self.location.origin)) client.postMessage({ type: "site-error", message, port });
      }
    }).catch(() => {});
  }
  return new Response(`9Remote: ${message}`, { status });
}

async function handle(request, url, inScope) {
  const port = inScope ? Number(inScope[1]) : await portFromReferrer(request);
  if (!port) return fail("no site context for this request", 503, null);

  // Prevent cross-site subresource access within shared origin.
  if (inScope && request.mode !== "navigate") {
    const from = await portFromReferrer(request);
    if (from && from !== port) {
      return new Response("9Remote: cross-site request refused", { status: 403 });
    }
  }

  await discoverBridge();
  if (!bridgeClient) return fail("bridge not connected — open the 9Remote app", 503, port);

  url.searchParams.delete("r");
  const path = inScope ? (inScope[2] || "/") : url.pathname;
  const target = path + (url.search || "");

  if (request.mode === "navigate") {
    bridgeClient.postMessage({ type: "site-nav", port, path });
  }

  const headers = {};
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "cookie") headers[key] = value;
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
    msg = await requestViaBridge(reqId, port, request.method, target, headers, bodyB64);
  } catch {
    return fail("request timed out", 504, port);
  }
  if (!msg || msg.error) return fail(msg?.error || "no reply from the agent", 502, port);

  const resHeaders = new Headers(msg.headers || {});

  const location = resHeaders.get("location");
  if (location && REDIRECT_STATUSES.includes(msg.status)) {
    let next = null;
    try {
      const abs = new URL(location, `http://localhost:${port}`);
      const sameSite = location.startsWith("/") || abs.host === `localhost:${port}`;
      if (sameSite) next = abs.pathname + abs.search;
    } catch { /* keep null */ }
    if (next) return Response.redirect(`/browse/${port}${next}`, msg.status);
    return Response.redirect(location, msg.status);
  }

  if (msg.status === 204 || msg.status === 304) {
    return new Response(null, { status: msg.status, headers: resHeaders });
  }

  // Enforce CSP on proxied site content.
  resHeaders.set("Content-Security-Policy", SITE_CSP);

  const bytes = base64ToBytes(msg.bodyB64);
  if ((resHeaders.get("content-type") || "").includes("text/html")) {
    const html = new TextDecoder("utf-8").decode(bytes);
    return new Response(injectIntoHtml(html, port), { status: msg.status, headers: resHeaders });
  }
  return new Response(bytes, { status: msg.status, headers: resHeaders });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  let url;
  try { url = new URL(request.url); } catch { return; }

  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw-site.js") return;
  if (url.pathname.startsWith("/cdn-cgi/")) return;

  const inScope = url.pathname.match(BROWSE_RE);
  if (inScope) {
    event.respondWith(handle(request, url, inScope));
    return;
  }

  // Handle root-relative subresource requests from in-scope pages.
  if (request.mode === "navigate") return;
  event.respondWith(handle(request, url, null));
});
