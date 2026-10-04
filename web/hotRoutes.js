// Hot-path session API — served from the outer worker BEFORE the Next pipeline.
// Rationale: these three endpoints are ~94% of worker CPU and their Next/OpenNext
// routing overhead is 35-75ms per request; served raw they cost 1-2ms. Logic is
// copied VERBATIM from web/app/api/session/{create,heartbeat,update}/route.js and
// web/shared/utils/{apiResponse,apiKey,sessionMutationAuth,db}.js.
//
// ⚠️ SYNC CONTRACT: any change to those routes or utils must be mirrored here
// (and vice versa). This file is inlined into worker.js by
// scripts/injectHotRoutes.mjs, so it cannot import shared modules — like
// SignalingDO.js, it keeps its own copies.

// ── apiResponse.js (verbatim) ─────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
};

function jsonOk(data) {
  return Response.json(data, { headers: corsHeaders });
}

function jsonError(message, status = 400) {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

function optionsResponse() {
  return new Response(null, { headers: corsHeaders });
}

// ── apiKey.js (verbatim, only what these routes use) ──────────────────────
function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;
  if (/^sk-[a-z0-9]{8}-[a-np-z1-9]{8}-[a-np-z1-9]{8}$/.test(apiKey)) {
    const [, machineId, a, b] = apiKey.split("-");
    return { machineId, keyId: a, version: 2, tail: b };
  }
  if (/^sk-[a-z0-9]{8}-[a-np-z1-9]{8}$/.test(apiKey)) {
    const [, machineId, a] = apiKey.split("-");
    return { machineId, keyId: a, version: 2 };
  }
  return null;
}

// Accepted at every API trust boundary: a v2 key, full or HEAD.
function isAcceptedApiKey(apiKey) {
  return parseApiKey(apiKey)?.version === 2;
}

// ── db.js (verbatim; only the retry helper these routes use) ──────────────
const D1_RETRY_MAX_ATTEMPTS = 3;
const D1_RETRY_BASE_MS = 500;
const TRANSIENT_D1_MARKERS = ["overloaded", "Network connection lost"];

function isTransientD1Error(e) {
  const msg = e?.message || String(e);
  return TRANSIENT_D1_MARKERS.some((marker) => msg.includes(marker));
}

async function withD1Retry(fn, { maxAttempts = D1_RETRY_MAX_ATTEMPTS, baseMs = D1_RETRY_BASE_MS } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= maxAttempts || !isTransientD1Error(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** (attempt - 1)));
    }
  }
}

// NOTE vs db.js: create/update call invalidateCache(cacheKeys.tunnel(apiKey)) there.
// That memo lives inside the Next bundle and can never be reached from here —
// which is exactly the existing cross-isolate situation: invalidation is already
// per-isolate only, and the 10s tunnel cache TTL remains the staleness ceiling.
// Nothing to do in this copy.

// ── sessionMutationAuth.js (verbatim) ─────────────────────────────────────
const MUTATION_MAX_SKEW_MS = 5 * 60 * 1000;

function mutationPayload({ apiKey, tunnelUrl, localIp, expiryMinutes, ts }) {
  const field = (v) => {
    const s = v == null ? "" : String(v);
    return `${s.length}:${s}`;
  };
  return `9remote-session-v1|${field(apiKey)}${field(tunnelUrl)}${field(localIp)}${field(expiryMinutes)}${field(ts)}`;
}

const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
]);

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verify(publicKeyB64, message, sigB64) {
  // The wire format is the raw 32-byte key; WebCrypto wants SPKI here, and
  // Workers' Ed25519 import is stricter than Node's about which it accepts.
  const raw = b64ToBytes(publicKeyB64);
  if (raw.length !== 32) return false;
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + 32);
  spki.set(ED25519_SPKI_PREFIX, 0);
  spki.set(raw, ED25519_SPKI_PREFIX.length);

  const key = await crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
  return await crypto.subtle.verify(
    "Ed25519",
    key,
    b64ToBytes(sigB64),
    new TextEncoder().encode(message)
  );
}

function canReplaceHostKey({ stored, presented, pairedNow }) {
  if (!stored) return true;              // first registration
  if (stored === presented) return true; // every restart re-sends the same key
  return pairedNow === true;
}

async function checkMutationAuth({ storedPublicKey, body, now = Date.now() }) {
  if (!storedPublicKey) return { ok: true };

  const { sig, ts } = body || {};
  if (typeof sig !== "string" || !sig) return { ok: false, reason: "signature-required" };
  if (typeof ts !== "number" || !Number.isFinite(ts)) return { ok: false, reason: "signature-required" };
  if (Math.abs(now - ts) > MUTATION_MAX_SKEW_MS) return { ok: false, reason: "stale" };

  try {
    const ok = await verify(storedPublicKey, mutationPayload(body), sig);
    return ok ? { ok: true } : { ok: false, reason: "bad-signature" };
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
}

// ── routes (verbatim bodies; getCloudflareContext → env param) ────────────

// POST /api/session/create — web/app/api/session/create/route.js
async function sessionCreate(request, env) {
  try {
    const { apiKey, hostPublicKey, hostX25519Key, tempKey } = await request.json();

    if (!(isAcceptedApiKey(apiKey))) return jsonError("Invalid API key");
    const { machineId } = parseApiKey(apiKey);

    const existing = await withD1Retry(() => env.DB.prepare(
      "SELECT hostPublicKey FROM sessions WHERE apiKey = ?"
    ).bind(apiKey).first());

    let pairedNow = false;
    if (existing?.hostPublicKey && hostPublicKey && existing.hostPublicKey !== hostPublicKey && tempKey) {
      // expires_at is epoch milliseconds here, not a datetime string — temp-key
      // create binds Date.now() + minutes, and verify compares it as a number.
      // datetime('now') would compare an integer against text, which in SQLite
      // makes the integer always smaller, so nothing would ever match.
      const paired = await withD1Retry(() => env.DB.prepare(
        "SELECT 1 AS ok FROM temp_keys WHERE temp_key = ? AND api_key = ? AND expires_at > ?"
      ).bind(String(tempKey).toUpperCase(), apiKey, Date.now()).first());
      pairedNow = !!paired;
    }

    const accepted = canReplaceHostKey({
      stored: existing?.hostPublicKey || null,
      presented: hostPublicKey || null,
      pairedNow
    });
    const keyToWrite = accepted ? (hostPublicKey || null) : existing.hostPublicKey;
    const sealKeyToWrite = accepted ? (hostX25519Key || null) : null;

    await withD1Retry(() => env.DB.prepare(`
      INSERT INTO sessions (machineId, apiKey, hostPublicKey, hostX25519Key, tunnelUrl, lastAccessAt, expiresAt)
      VALUES (?, ?, ?, ?, NULL, datetime('now'), datetime('now', '+7 days'))
      ON CONFLICT(apiKey)
      DO UPDATE SET
        -- Clear stale tunnelUrl on fresh agent start so clients do not try old tunnels
        tunnelUrl = NULL,
        -- COALESCE keeps a registered key when this call carries none (an older
        -- agent, or one that failed to read hostKey.json).
        hostPublicKey = COALESCE(excluded.hostPublicKey, sessions.hostPublicKey),
        hostX25519Key = COALESCE(excluded.hostX25519Key, sessions.hostX25519Key),
        lastAccessAt = datetime('now'),
        expiresAt = datetime('now', '+7 days')
    `).bind(machineId, apiKey, keyToWrite, sealKeyToWrite).run());

    return jsonOk({ success: true, machineId });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

// POST /api/session/heartbeat — web/app/api/session/heartbeat/route.js
async function sessionHeartbeat(request, env) {
  try {
    const body = await request.json();
    const { apiKey, online } = body;

    if (!apiKey) return jsonError("Missing apiKey");
    if (!(isAcceptedApiKey(apiKey))) return jsonError("Invalid API key");

    const row = await withD1Retry(() => env.DB.prepare(
      "SELECT hostPublicKey FROM sessions WHERE apiKey = ?"
    ).bind(apiKey).first());
    const auth = await checkMutationAuth({ storedPublicKey: row?.hostPublicKey, body });
    if (!auth.ok) return jsonError(`Unauthorized: ${auth.reason}`, 403);

    await withD1Retry(() => env.DB.prepare(
      "UPDATE sessions SET agentOnline = ?, agentSeenAt = datetime('now') WHERE apiKey = ?"
    ).bind(online ? 1 : 0, apiKey).run());

    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

// POST /api/session/update — web/app/api/session/update/route.js
async function sessionUpdate(request, env) {
  try {
    const body = await request.json();
    const { apiKey, tunnelUrl, localIp } = body;

    if (!(isAcceptedApiKey(apiKey))) return jsonError("Invalid API key");

    const row = await withD1Retry(() => env.DB.prepare(
      "SELECT hostPublicKey FROM sessions WHERE apiKey = ?"
    ).bind(apiKey).first());
    const auth = await checkMutationAuth({ storedPublicKey: row?.hostPublicKey, body });
    if (!auth.ok) return jsonError(`Unauthorized: ${auth.reason}`, 403);

    const publicIp = request.headers.get("CF-Connecting-IP") || null;

    await withD1Retry(() => env.DB.prepare(`
      UPDATE sessions SET tunnelUrl = ?, publicIp = ?, localIp = ?, lastAccessAt = datetime('now')
      WHERE apiKey = ?
    `).bind(tunnelUrl, publicIp, localIp || null, apiKey).run());

    return jsonOk({ success: true });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}

const HOT_ROUTES = {
  "/api/session/create": sessionCreate,
  "/api/session/heartbeat": sessionHeartbeat,
  "/api/session/update": sessionUpdate,
};

// Outer-worker entry. Returns null for anything it does not own (other methods,
// other /api/session/* paths like /delete) so the caller falls through to Next,
// which still keeps the original routes as the source of truth and fallback.
export async function handleHotRoutes(request, env) {
  const handler = HOT_ROUTES[new URL(request.url).pathname];
  if (!handler) return null;
  if (request.method === "OPTIONS") return optionsResponse();
  if (request.method !== "POST") return null;
  return handler(request, env);
}
