import dns from "node:dns/promises";
import { execFile } from "node:child_process";

const CACHE_TTL = 30000;
// Failures are cached far more briefly: a phone that just joined the LAN should
// become resolvable within one ICE window, not after a full success-TTL.
const NEG_CACHE_TTL = 3000;
const MDNS_TIMEOUT_MS = 1500;
// Close the multicast socket once ICE has gone quiet — an agent idles for hours
// between connections and shouldn't hold port 5353 the whole time.
const MDNS_IDLE_MS = 60000;
// Browsers mint a fresh UUID hostname per session, so cache keys are never
// reused — without a cap the map grows for the life of the agent.
const CACHE_MAX = 256;
const LOCAL_RE = /\s([^\s]+\.local)\s/i;
// A hostname is passed to dns-sd as an argv element, never through a shell, but
// it still arrives from a remote peer — keep it to what a real .local name is.
const SAFE_HOST_RE = /^[a-z0-9][a-z0-9._-]{0,252}\.local$/i;
// Browsers mint a per-session UUID hostname and answer it ONLY inside their own
// WebRTC stack — an outside resolver (dns-sd, multicast) never gets a reply. So
// skip the query entirely instead of burning MDNS_TIMEOUT_MS per candidate. The
// LAN path still works: the browser hole-punches to us and arrives as prflx.
const EPHEMERAL_HOST_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/i;
const IPV4_RE = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;

const cache = new Map();
// hostname → in-flight promise. Candidates arrive in bursts of 2-3 for the same
// peer, so without this each one runs its own lookup for the same answer.
const inflight = new Map();

// ─── macOS: ask mDNSResponder ────────────────────────────────────────────────
// It owns port 5353 exclusively, so a second multicast socket binds fine but
// never receives a packet — multicast-dns returns nothing here while dns-sd
// answers instantly. Talk to the daemon instead of competing with it.
function queryDnsSd(hostname) {
  return new Promise((resolve) => {
    // dns-sd streams results and never exits on its own; take the first A record
    // and kill it. execFile (no shell) — hostname is remote input.
    const child = execFile("dns-sd", ["-G", "v4", hostname], { timeout: MDNS_TIMEOUT_MS });
    let done = false;
    const finish = (ip) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(ip);
    };
    const timer = setTimeout(() => finish(null), MDNS_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        // "<ts>  Add  <flags>  <if>  <host>.  <ip>  <ttl>" — Rmv lines are stale.
        if (!line.includes(" Add ")) continue;
        const ip = line.match(IPV4_RE)?.[1];
        if (ip && ip !== "127.0.0.1") return finish(ip);
      }
    });
    child.on("error", () => finish(null)); // dns-sd missing → caller drops the candidate
    child.on("close", () => finish(null));
  });
}

// ─── Other platforms: multicast socket ───────────────────────────────────────
// One shared socket, reopened on demand. Per-query open/close looked cleaner but
// rebinding 5353 that fast makes the next query miss outright.
let socket = null;
let idleTimer = null;
// lowercased hostname → resolver. A single "response" listener dispatches to all
// waiters; one listener per query tripped the EventEmitter leak warning.
const waiters = new Map();

async function getSocket() {
  if (socket) return socket;
  const { default: makeMdns } = await import("multicast-dns");
  try {
    socket = makeMdns({ reuseAddr: true });
  } catch {
    return null; // port 5353 unavailable (another responder owns it exclusively)
  }
  socket.on("error", closeSocket);
  socket.on("response", (res) => {
    if (!waiters.size) return;
    for (const r of [...(res.answers || []), ...(res.additionals || [])]) {
      // IPv4 only — a link-local AAAA (fe80::) carries no zone index here, so
      // the resulting candidate would be unusable anyway.
      if (r.type !== "A") continue;
      waiters.get(String(r.name).toLowerCase())?.(r.data);
    }
  });
  return socket;
}

function closeSocket() {
  clearTimeout(idleTimer);
  idleTimer = null;
  const s = socket;
  socket = null;
  try { s?.destroy(); } catch {}
  // A query in flight when the socket dies would otherwise wait out its full
  // timeout against a socket that can no longer answer.
  for (const settle of [...waiters.values()]) settle(null);
  waiters.clear();
}

function armIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(closeSocket, MDNS_IDLE_MS);
  idleTimer.unref?.(); // never hold the process open
}

async function queryMulticast(hostname) {
  const mdns = await getSocket();
  if (!mdns) return null;
  const wanted = hostname.toLowerCase();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ip) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      waiters.delete(wanted);
      armIdleClose();
      resolve(ip);
    };
    const timer = setTimeout(() => finish(null), MDNS_TIMEOUT_MS);
    timer.unref?.();
    waiters.set(wanted, finish);
    try { mdns.query({ questions: [{ name: hostname, type: "A" }] }); }
    catch { finish(null); }
  });
}

// Direct mDNS query — getaddrinfo does NOT consult mDNSResponder on macOS, so
// dns.lookup(".local") always fails there and every LAN candidate was dropped.
function queryMdns(hostname) {
  return process.platform === "darwin" ? queryDnsSd(hostname) : queryMulticast(hostname);
}

// Resolve .local hostname → IP. System resolver first (Linux nss-mdns, Windows
// DNR answer it), then a direct mDNS query for platforms that don't.
async function resolveLocal(hostname) {
  const cached = cache.get(hostname);
  if (cached) {
    const ttl = cached.ip ? CACHE_TTL : NEG_CACHE_TTL;
    if (Date.now() - cached.ts < ttl) return cached.ip;
  }
  const pending = inflight.get(hostname);
  if (pending) return pending;

  const task = (async () => {
    let ip = null;
    try {
      ip = (await dns.lookup(hostname, { family: 4 })).address;
    } catch {
      ip = await queryMdns(hostname);
    }
    // Map iterates in insertion order — the first key is the oldest entry.
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(hostname, { ip, ts: Date.now() });
    return ip;
  })().finally(() => inflight.delete(hostname));

  inflight.set(hostname, task);
  return task;
}

// Extract the .local hostname from an ICE candidate line, or null if it has none
// or the name isn't one we're willing to hand to a resolver.
export function parseLocalHost(candidateStr) {
  const host = candidateStr.match(LOCAL_RE)?.[1];
  if (!host || !SAFE_HOST_RE.test(host)) return null;
  return EPHEMERAL_HOST_RE.test(host) ? null : host;
}

// Replace .local hostname in ICE candidate with resolved IP. Returns null if
// unresolvable — a .local left in place would be a candidate ICE can't use.
export async function resolveCandidate(candidateStr) {
  const hostname = parseLocalHost(candidateStr);
  if (!hostname) return LOCAL_RE.test(candidateStr) ? null : candidateStr;
  const ip = await resolveLocal(hostname);
  if (!ip) return null;
  return candidateStr.replace(hostname, ip);
}

// Test seam — cache/inflight are module state that would leak between cases.
export function _resetCache() {
  cache.clear();
  inflight.clear();
}

// Released on shutdown so the multicast socket doesn't outlive the agent.
export function closeMdns() {
  closeSocket();
}
