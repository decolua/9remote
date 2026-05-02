import dns from "node:dns/promises";

const CACHE_TTL = 30000;
const LOCAL_RE = /\s([0-9a-f-]{8,}\.local)\s/i;

const cache = new Map();

// Resolve .local hostname → IP via system resolver (macOS mDNSResponder, Linux nss-mdns, Windows DNR)
async function resolveLocal(hostname) {
  const cached = cache.get(hostname);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.ip;
  try {
    const { address } = await dns.lookup(hostname);
    cache.set(hostname, { ip: address, ts: Date.now() });
    return address;
  } catch {
    return null;
  }
}

// Replace .local hostname in ICE candidate with resolved IP. Returns null if unresolvable.
export async function resolveCandidate(candidateStr) {
  const match = candidateStr.match(LOCAL_RE);
  if (!match) return candidateStr;
  const ip = await resolveLocal(match[1]);
  if (!ip) return null;
  return candidateStr.replace(match[1], ip);
}
