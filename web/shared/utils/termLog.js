// Dev-only terminal/output logger with a ring buffer + UI viewer.
// Mobile browsers can't open DevTools console, so on dev deploys (dev.*) or when
// the localStorage flag is set, we collect entries here for the in-app log panel.
const MAX = 800;
const buffer = [];
const listeners = new Set();

const isBrowser = typeof window !== "undefined";
// Auto-enable on dev subdomain (dev.9remote.cc) or explicit opt-in. Production
// (9remote.cc) is always off — zero overhead, no buffer growth.
const enabled = isBrowser && (
  location.hostname.startsWith("dev.") ||
  location.hostname === "localhost" ||
  localStorage.getItem("9remote:termLog") === "1"
);

export function isTermLogEnabled() { return enabled; }

export function getTermLog() { return buffer; }

export function onTermLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearTermLog() {
  buffer.length = 0;
  for (const fn of listeners) {
    try { fn(null); } catch (e) { void e; }
  }
}

function fmt(a) {
  if (a == null) return "";
  if (a instanceof Uint8Array || ArrayBuffer.isView(a)) return `<${a.byteLength}b>`;
  if (a instanceof ArrayBuffer) return `<${a.byteLength}b>`;
  if (typeof a === "string") return a.length > 120 ? `${a.slice(0, 60)}…${a.length}b` : a;
  if (typeof a === "object") {
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  return String(a);
}

// category examples: "recv" (output received), "join", "reconnect", "switch" (carrier),
// "resize", "send". Args are formatted; binary shown as <Nb>.
//
// Spam control: high-frequency categories (recv — agent streams many chunks/sec)
// are coalesced — rapid repeats within COALESCE_MS roll into one entry shown as ×N,
// so the buffer isn't drowned by output and connect/reconnect/switch stay visible.
const COALESCE_MS = 300;
const COALESCE_CATS = new Set(["recv"]);
let lastEntry = null;

export function termLog(category, ...args) {
  if (!enabled) return;
  const now = Date.now();
  const msg = args.map(fmt).join(" ");
  if (COALESCE_CATS.has(category) && lastEntry && lastEntry.category === category && now - lastEntry.ts < COALESCE_MS) {
    lastEntry.count = (lastEntry.count || 1) + 1;
    lastEntry.ts = now;
    lastEntry.msg = `${msg} ×${lastEntry.count}`;
    for (const fn of listeners) {
      try { fn(lastEntry); } catch (e) { void e; }
    }
    return;
  }
  const entry = { ts: now, category, msg, count: 1 };
  lastEntry = entry;
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  console.log(`[termLog:${category}]`, ...args);
  for (const fn of listeners) {
    try { fn(entry); } catch (e) { void e; }
  }
}
