// Failure-only rate limiting for credential endpoints.
//
// Counting failures rather than requests is what keeps this invisible to real
// users: a legitimate client succeeds (valid QR, correct password, valid apiKey)
// and never increments anything, while a brute-forcer fails on essentially every
// attempt. A reconnect storm hammering /api/connect with a valid key is therefore
// unaffected no matter how many requests it makes.
//
// Two layers:
//  1. A per-isolate block list — once an IP is over the limit, later requests are
//     rejected before bcrypt, before D1, before even calling limit(). This is what
//     stops an attacker from costing us CPU and database load.
//  2. The Cloudflare rate limiting binding — durable across isolates, though
//     counted per location, so a distributed attacker gets a higher effective
//     ceiling. Acceptable: the goal is to make exhaustive search infeasible, and
//     the short key/CRC space needs orders of magnitude, not a hard cap.

// Windows are per client IP. Limits are deliberately well above what a human hits
// by mistake — the point is to stop automated search, not to punish typos.
export const RATE_LIMITS = {
  // Wrong password. Stricter threshold for admin authentication to prevent brute-force.
  adminLogin: { limit: 5, windowSec: 60 },
  // Invalid or expired temp key. Shared/CGNAT mobile IPs make this the most likely
  // place for innocent collisions, so it is the most generous of the three.
  tempKeyVerify: { limit: 40, windowSec: 60 },
  // Failed apiKey verification. Only forged or corrupted keys land here.
  connect: { limit: 60, windowSec: 60 },
};

const BLOCK_MAP_MAX_ENTRIES = 10000;

// key -> { count, resetAt }
const failures = new Map();

function prune(now) {
  for (const [key, entry] of failures) {
    if (entry.resetAt <= now) failures.delete(key);
  }
  if (failures.size > BLOCK_MAP_MAX_ENTRIES) {
    const excess = failures.size - BLOCK_MAP_MAX_ENTRIES;
    let i = 0;
    for (const key of failures.keys()) {
      if (i++ >= excess) break;
      failures.delete(key);
    }
  }
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

/**
 * True when this client has already exceeded the limit and should be rejected
 * without doing any work. Call at the top of a route, before any lookup.
 */
export function isRateLimited(scope, ip, { limit, windowSec }) {
  const now = Date.now();
  const entry = failures.get(`${scope}:${ip}`);
  if (!entry) return false;
  if (entry.resetAt <= now) {
    failures.delete(`${scope}:${ip}`);
    return false;
  }
  return entry.count >= limit;
}

/**
 * Record a failed attempt. Also consumes a token from the Cloudflare binding when
 * one is configured, so the count survives isolate churn.
 */
export async function recordFailure(scope, ip, { windowSec }, limiter) {
  const now = Date.now();
  const key = `${scope}:${ip}`;
  const entry = failures.get(key);

  if (!entry || entry.resetAt <= now) {
    if (failures.size >= BLOCK_MAP_MAX_ENTRIES) prune(now);
    // Fixed window: the reset time is set once and not extended by later failures,
    // so a blocked client always recovers within windowSec.
    failures.set(key, { count: 1, resetAt: now + windowSec * 1000 });
  } else {
    entry.count++;
  }

  if (limiter) await limiter.limit({ key }).catch(() => {});
}

/**
 * Clear the counter after a success. A user who mistypes a password and then gets
 * it right, or whose expired QR is replaced by a fresh one, starts clean instead
 * of carrying failures for the rest of the window.
 */
export function clearFailures(scope, ip) {
  failures.delete(`${scope}:${ip}`);
}
