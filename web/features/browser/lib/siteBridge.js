"use client";

// Site bridge — the glue between the /browse/ service worker and the transport
// socket (proxySocket facade: emit routes RTC-first, on/off survive reconnects).
// One instance per page; initSiteBridge is idempotent.

import { SITE_SW_URL, SITE_SW_SCOPE, SITE_NAV_EVENT, SITE_REPLY_TIMEOUT_MS, SITES_FETCH_TIMEOUT_MS } from "../constants/browserConfig";

let socket = null;
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
    // runAgentRequest registers the entry before emitting — a chunk with no
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

function runAgentRequest(msg) {
  const { reqId } = msg;
  return new Promise((resolve) => {
    const entry = { slots: [], total: null, status: null, headers: null, resolve, timer: null };
    entry.timer = setTimeout(() => {
      pendingChunks.delete(reqId);
      resolve({ reqId, error: "timeout" });
    }, SITE_REPLY_TIMEOUT_MS);
    pendingChunks.set(reqId, entry);
    socket?.emit?.("site:httpRequest", msg, () => {});
  });
}

function onSwMessage(event) {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "http-request") {
    runAgentRequest(msg).then((reply) => event.ports?.[0]?.postMessage(reply));
    return;
  }
  if (msg.type === "site-nav") {
    window.dispatchEvent(new CustomEvent(SITE_NAV_EVENT, { detail: { port: msg.port, path: msg.path } }));
    return;
  }
  // SW woke up (browser killed it idle) and lost its bridge pointer — re-hello
  if (msg.type === "sw-hello") {
    try { event.source?.postMessage?.({ type: "bridge-hello" }); } catch { /* worker gone */ }
  }
}

async function helloToWorker(worker) {
  try { worker?.postMessage?.({ type: "bridge-hello" }); } catch { /* not ready */ }
}

export async function initSiteBridge(sock) {
  // Subscribe on every call — socket.on is Set-backed, so re-adds are free
  if (sock) {
    socket = sock;
    socket.on?.("site:httpChunk", onChunk);
  }
  if (!initiated && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    initiated = true;
    navigator.serviceWorker.addEventListener("message", onSwMessage);
    try {
      const reg = await navigator.serviceWorker.register(SITE_SW_URL, { scope: SITE_SW_SCOPE });
      const sayHello = () => helloToWorker(reg.active || reg.waiting || reg.installing);
      sayHello();
      // An installing worker becomes active later — re-hello so it knows this page
      reg.addEventListener("updatefound", () => {
        reg.installing?.addEventListener("statechange", () => {
          if (reg.installing?.state === "activated" || reg.waiting?.state === "activated") sayHello();
        });
      });
    } catch (err) {
      console.error("[siteBridge] SW registration failed:", err);
    }
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
