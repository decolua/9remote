// Turn-key selection, isolated from the route so the round-robin and the
// scope/fallback rules can be tested without D1 or a Cloudflare account.
//
// Keys are picked by oldest lastUsedAt (not a counter) — the SQL both selects
// and stamps in one statement, so concurrent requests cannot hand out the same
// key twice.

export const TURN_SCOPES = ["dev", "prod", "both"];

// Hosts that count as the dev environment. The prod worker allows dev.9remote.cc
// too (its ALLOWED_ORIGINS covers both zones), so the origin list cannot decide
// this — the hostname is the only thing that actually differs.
// hostname is used instead of host so a port is never part of the comparison;
// for IPv6 it keeps its brackets (`[::1]`), so that is the form to match.
const DEV_HOST_PREFIX = "dev.";
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

// Where a new key is created. TURN keys live in the account, not the zone, and
// a key created here must match the account whose keyId/secret is pasted back.
export const TURN_DASHBOARD_URL = "https://dash.cloudflare.com/?to=/:account/realtime/turn";

const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";

// CURRENT_TIMESTAMP has one-second resolution: two picks inside the same second
// tie and hand out the same key. Milliseconds keep the rotation strict.
const NOW_MS = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** The key a client running on `origin` should use. Credentials are only valid
 *  for the key that minted them, so a dev page must never get a prod key. */
export function scopeForOrigin(origin) {
  const host = safeHost(origin);
  if (!host) return "prod";
  const name = host.hostname;
  if (LOCAL_HOSTS.includes(name)) return "dev";
  return name.startsWith(DEV_HOST_PREFIX) ? "dev" : "prod";
}

function safeHost(origin) {
  try { return new URL(origin); } catch { return null; }
}

/** Oldest-used enabled key in scope, then env-var fallback, then null. */
export async function pickTurnKey(db, scope, env) {
  const row = await db.prepare(`
    UPDATE turnKeys SET lastUsedAt = ${NOW_MS}
    WHERE id = (
      SELECT id FROM turnKeys
      WHERE enabled = 1 AND scope IN (?, 'both')
      ORDER BY COALESCE(lastUsedAt, '') ASC, id ASC LIMIT 1
    )
    RETURNING keyId, secret
  `).bind(scope).first();
  if (row?.keyId && row?.secret) return row;

  // No key configured yet — the deployed secret keeps working until an admin
  // adds the first row, so shipping this does not break a running deploy.
  if (env.TURN_KEY_ID && env.TURN_KEY_SECRET) {
    return { keyId: env.TURN_KEY_ID, secret: env.TURN_KEY_SECRET };
  }
  return null;
}

/** Generate ice servers for one key. Empty on failure — a caller with no relay
 *  still connects over STUN, so a dead key must not read as a hard error. */
export async function generateIceServers({ keyId, secret, ttl = 86400 }) {
  try {
    const resp = await fetch(`${TURN_API}/${keyId}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl })
    });
    if (!resp.ok) return { iceServers: [], error: `HTTP ${resp.status}` };
    const { iceServers } = await resp.json();
    return { iceServers: iceServers || [] };
  } catch (e) {
    return { iceServers: [], error: e?.message || String(e) };
  }
}

// A key's secret is shown once at creation and never again — the list view
// returns this instead.
export function tailOfSecret(secret) {
  return secret ? `…${secret.slice(-4)}` : "";
}
