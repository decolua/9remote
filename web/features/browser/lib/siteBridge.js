"use client";

// Site bridge — the glue between the /browse/ service worker and the transport
// bus (ClientBus facade: emit routes RTC-first, on/off survive carrier changes).
// One instance per page; initSiteBridge is idempotent.

import { SITE_NAV_EVENT, SITE_ERROR_EVENT, SITE_REPLY_TIMEOUT_MS, SITES_FETCH_TIMEOUT_MS, isSitesOrigin, SITES_ORIGIN } from "../constants/browserConfig";

// The proxy shell on the sites origin owns the service worker now — this page
// cannot reach that worker directly, which is the point: the worker serves the
// browsed site, and the site must not land on the origin holding the keys.
let bus = null;
let initiated = false;

// reqId → {slots: [], total, status, headers, resolve, timer}
const pendingChunks = new Map();

function replyFor(reqId) {
  const entry = pendingChunks.get(reqId);
  if (!entry || entry.total == null) return null;
  // Explicit index check — sparse-array holes are skipped by some()/every()
  for (let i = 0; i < entry.total; i++) {
    if (entry.slots[i] === undefined) return null;
  }
  const b64 = entry.slots.join("");
  clearTimeout(entry.timer);
  pendingChunks.delete(reqId);
  return { reqId, status: entry.status, headers: entry.headers, bodyB64: b64 };
}

function onChunk(data) {
  if (!data || typeof data.reqId !== "string") return;
  let entry = pendingChunks.get(data.reqId);
  if (data.error) {
    if (!entry?.resolve) return;
    clearTimeout(entry.timer);
    pendingChunks.delete(data.reqId);
    entry.resolve({ reqId: data.reqId, error: data.error });
    return;
  }
  if (!entry) {
    // runHostRequest registers the entry before emitting — a chunk with no
    // entry is a late straggler after the reply already resolved. Ignore.
    return;
  }
  if (data.seq === 0) {
    entry.total = data.total;
    entry.status = data.status;
    entry.headers = data.headers;
  }
  entry.slots[data.seq] = data.b64 || "";
  const done = replyFor(data.reqId);
  if (done && entry.resolve) entry.resolve(done);
}

function runHostRequest(msg) {
  const { reqId } = msg;
  return new Promise((resolve) => {
    const entry = { slots: [], total: null, status: null, headers: null, resolve, timer: null };
    entry.timer = setTimeout(() => {
      pendingChunks.delete(reqId);
      resolve({ reqId, error: "timeout" });
    }, SITE_REPLY_TIMEOUT_MS);
    pendingChunks.set(reqId, entry);
    bus?.emit?.("site:httpRequest", msg, () => {});
  });
}

function onProxyMessage(event) {
  // The proxy shell asks this page to reach the host, so anything arriving
  // here speaks with the bus's authority. Only the shell's own origin may.
  if (!isSitesOrigin(event.origin)) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "site:request") {
    runHostRequest(msg.payload).then((reply) => {
      try {
        event.source?.postMessage({ type: "site:reply", id: msg.id, payload: reply }, SITES_ORIGIN);
      } catch { /* shell gone */ }
    });
    return;
  }
  if (msg.type === "site:nav") {
    window.dispatchEvent(new CustomEvent(SITE_NAV_EVENT, { detail: { port: msg.port, path: msg.path } }));
    return;
  }
  // Noted but unused: the shell is addressed by its src, not by messages.
  if (msg.type === "site:ready") return;

  // The shell reports what the worker could not do. Its own document shows a
  // one-line status, but the failure is about the frame's content — the view
  // is what can say it in the app's own chrome.
  if (msg.type === "site:swBlocked") {
    window.dispatchEvent(new CustomEvent(SITE_ERROR_EVENT, { detail: { message: "service-worker-blocked" } }));
    return;
  }
  // The worker reporting why a page could not be served at all.
  if (msg.type === "site-error") {
    window.dispatchEvent(new CustomEvent(SITE_ERROR_EVENT, { detail: { message: msg.message, port: msg.port } }));
    return;
  }
}

export async function initSiteBridge(sock) {
  // Off-first: the bus handler list is array-backed, a bare re-on would stack
  // a duplicate onChunk on every BrowserView remount.
  if (sock) {
    bus = sock;
    bus.off?.("site:httpChunk", onChunk);
    bus.on?.("site:httpChunk", onChunk);
  }
  if (!initiated && typeof window !== "undefined") {
    initiated = true;
    window.addEventListener("message", onProxyMessage);
  }
}

export function fetchLocalSites(sock) {
  const s = sock?.current || sock;
  return new Promise((resolve) => {
    if (!s?.connected) return resolve(null);
    const timer = setTimeout(() => resolve(null), SITES_FETCH_TIMEOUT_MS);
    s.emit("getLocalSites", (result) => {
      clearTimeout(timer);
      resolve(Array.isArray(result?.sites) ? result.sites : null);
    });
  });
}

// Address bar parsing: "localhost:3000/x", ":3000", "3000", "/x" (current port)
export function parseSiteAddress(input, currentPort) {
  const s = (input || "").trim();
  if (!s) return null;
  let m = s.match(/^(?:https?:\/\/)?localhost:(\d{1,5})(\/.*)?$/i);
  if (m) return { port: Number(m[1]), path: m[2] || "/" };
  m = s.match(/^:(\d{1,5})(\/.*)?$/);
  if (m) return { port: Number(m[1]), path: m[2] || "/" };
  m = s.match(/^(\d{1,5})(\/.*)?$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 65535) return { port: Number(m[1]), path: m[2] || "/" };
  if (s.startsWith("/") && currentPort) return { port: currentPort, path: s };
  return null;
}
