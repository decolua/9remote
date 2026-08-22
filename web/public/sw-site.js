// 9Remote site proxy service worker.
// Serves /browse/<port>/... documents from the agent over the live transport
// (RTC data channel preferred, WS tunnel fallback) by relaying each request to
// a bridge page that owns the transport socket. The tunnel HTTP proxy (/proxy/*)
// is untouched — this is a parallel, RTC-capable path.
//
// The browser may terminate this worker any idle moment; module state (the
// bridge pointer) dies with it. Every request re-discovers the bridge on demand.

const BROWSE_RE = /^\/browse\/(\d{1,5})(\/.*)?$/;
const BRIDGE_TIMEOUT_MS = 60000;
const BRIDGE_DISCOVER_MS = 3000;
const MAX_REQUEST_BODY_BYTES = 512 * 1024;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

let bridgeClient = null;
let bridgeDiscover = null; // in-flight discovery promise
let bridgeResolve = null;  // its resolver — hello handler fires it
let reqCounter = 0;

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "bridge-hello") {
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

// Ask every same-origin page "are you the bridge?" and wait for a hello.
function discoverBridge() {
  if (bridgeClient) return Promise.resolve();
  if (!bridgeDiscover) {
    bridgeDiscover = new Promise((resolve) => {
      bridgeResolve = resolve;
      setTimeout(() => {
        bridgeDiscover = null;
        bridgeResolve = null;
        resolve(); // no hello in time — caller reports "not connected"
      }, BRIDGE_DISCOVER_MS);
    });
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: "sw-hello" });
    }).catch(() => {});
  }
  return bridgeDiscover;
}


// Injected into every HTML page served here. Top-level navigations to paths
// OUTSIDE the SW scope are never handed to this worker (scope gates navigation,
// unlike subresources), so absolute-path links must be rewritten in the page.
// location.replace keeps the parent app's history clean — an iframe navigation
// would otherwise push an entry and swallow the app's own Back button.
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
  // Bubble phase on purpose: an SPA router gets its click first and calls
  // preventDefault for routes it owns, so its soft navigation is left alone.
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
  // Form submits are top-level navigations too — same out-of-scope 404 as links.
  document.addEventListener("submit", function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!form || form.tagName !== "FORM" || form.target && form.target !== "_self") return;
    var action = form.getAttribute("action");
    if (action === null) return; // no action = posts to current (already scoped) URL
    var url;
    try { url = new URL(action, location.href); } catch (err) { return; }
    if (url.origin !== location.origin) return;
    var next = scoped(url.pathname);
    if (next) form.setAttribute("action", next + url.search);
  }, true);
  // pushState is downgraded to replaceState: an iframe entry lands on the parent
  // app's joint history, so an SPA route change here would swallow the app's Back.
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
  // Function replacement — "$&" and friends in the tag must stay literal
  if (head) return html.replace(head[0], () => head[0] + tag);
  return tag + html;
}

// The port a controlled page belongs to: referrer first, then live clients.
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

// One MessageChannel per request — port2 travels to the bridge, port1 waits for
// the reply. Keeps concurrent requests isolated and worker-restart-safe.
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

async function handle(request, url, inScope) {
  const port = inScope ? Number(inScope[1]) : await portFromReferrer(request);
  if (!port) return new Response("9Remote: no site context for this request", { status: 503 });

  await discoverBridge();
  if (!bridgeClient) return new Response("9Remote: bridge not connected — open the 9Remote app", { status: 503 });

  // Drop the iframe cache-buster param before forwarding to the agent
  url.searchParams.delete("r");
  const path = inScope ? (inScope[2] || "/") : url.pathname;
  const target = path + (url.search || "");

  // Let the app's address bar follow in-iframe navigations
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
    return new Response("9Remote: request timed out", { status: 504 });
  }
  if (!msg || msg.error) return new Response(`9Remote: ${msg?.error || "no reply"}`, { status: 502 });

  const resHeaders = new Headers(msg.headers || {});

  // Redirects: point back into the browse scope so the next hop stays SW-served
  const location = resHeaders.get("location");
  if (location && REDIRECT_STATUSES.includes(msg.status)) {
    let next = null;
    try {
      const abs = new URL(location, `http://localhost:${port}`);
      const sameSite = location.startsWith("/") || abs.host === `localhost:${port}`;
      if (sameSite) next = abs.pathname + abs.search;
    } catch { /* keep null */ }
    if (next) return Response.redirect(`/browse/${port}${next}`, msg.status);
    // External redirect — hand the browser the original absolute URL
    return Response.redirect(location, msg.status);
  }

  if (msg.status === 204 || msg.status === 304) {
    return new Response(null, { status: msg.status, headers: resHeaders });
  }

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

  if (url.origin !== self.location.origin) return; // CDN/external — direct network
  if (url.pathname === "/sw-site.js") return;      // own script

  const inScope = url.pathname.match(BROWSE_RE);
  if (inScope) {
    event.respondWith(handle(request, url, inScope));
    return;
  }

  // Out-of-scope top-level navigation never reaches this worker (scope gates
  // navigation), so only subresources land here: dev servers request absolute
  // paths like "/vite.svg" or "/@vite/client" from a page inside the scope.
  if (request.mode === "navigate") return;
  event.respondWith(handle(request, url, null));
});
