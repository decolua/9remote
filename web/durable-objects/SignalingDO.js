import { DurableObject } from "cloudflare:workers";

// Per-isolate rate limit for the session gate — a reconnect-storming client must
// not hammer D1 through this check. Threshold sits above a legit agent's backoff
// (1s+2s+4s... ≈ 6 attempts/15s) but below storm rates (30+/s).
const GATE_RATE_MAX = 10;
const GATE_RATE_WINDOW_MS = 15000;
const GATE_MAP_PRUNE_SIZE = 5000;
const gateHits = new Map();

// Per-isolate memo for the gate lookup. Not Workers KV: KV propagates deletes
// across colos in up to 60s (slowest exactly where a key is read most), so a
// revoked session could outlive its invalidation — the wrong direction to be
// wrong in for an auth gate. A local map is stale for at most GATE_CACHE_TTL_MS.
// This file is inlined verbatim into worker.js by scripts/injectSignalingDO.mjs,
// so it cannot import shared/utils/db and keeps its own map and TTL.
const GATE_CACHE_TTL_MS = 30000;
const gateCache = new Map();

function gateRateLimited(apiKey) {
  const now = Date.now();
  if (gateHits.size > GATE_MAP_PRUNE_SIZE) {
    for (const [key, hit] of gateHits) {
      if (now - hit.start >= GATE_RATE_WINDOW_MS) gateHits.delete(key);
    }
  }
  const hit = gateHits.get(apiKey);
  if (!hit || now - hit.start >= GATE_RATE_WINDOW_MS) {
    gateHits.set(apiKey, { start: now, count: 1 });
    return false;
  }
  hit.count++;
  return hit.count > GATE_RATE_MAX;
}

// The single hottest D1 read in the system — every WS (re)connect hits it, and a
// client in an RTC reconnect loop hits it repeatedly.
//
// Revocation is bounded by GATE_CACHE_TTL_MS, not immediate: this map lives in the
// worker isolate, so /api/session/delete cannot reach it. Deleting a session still
// takes effect at once everywhere else (the D1 row is gone); only new signaling
// sockets for that key can slip through, for at most one TTL.
async function sessionExists(apiKey, env) {
  const now = Date.now();
  const hit = gateCache.get(apiKey);
  if (hit && hit > now) return true;

  // Primary, not a replica: this is an auth gate, and a replica that has not seen
  // a session deletion yet would keep authorizing a revoked key. The memo above
  // already absorbs the volume, so the miss path can afford the primary.
  const row = await env.DB.prepare("SELECT 1 FROM sessions WHERE apiKey = ?").bind(apiKey).first();
  if (!row) {
    gateCache.delete(apiKey);
    return false;
  }

  // Only positive results are cached, so a session created moments ago is never
  // masked by a cached miss.
  if (gateCache.size > GATE_MAP_PRUNE_SIZE) {
    for (const [key, expires] of gateCache) {
      if (expires <= now) gateCache.delete(key);
    }
  }
  gateCache.set(apiKey, now + GATE_CACHE_TTL_MS);
  return true;
}

// Worker-level route handler — gates WS upgrade on apiKey, fans out to room DO.
// Auth mirrors /api/connect: a live session row for this apiKey must exist.
export async function handleSignaling(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/signaling\/ws\/([^/]+)$/);
  if (!match) return new Response("Not found", { status: 404 });

  const upgrade = request.headers.get("Upgrade");
  if (!upgrade || upgrade !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const role = url.searchParams.get("role");
  if (role !== "agent" && role !== "client") {
    return new Response("Invalid role (agent|client)", { status: 400 });
  }

  // apiKey gate — no valid session = no signaling. Stops RTC-bypass of device approval.
  const apiKey = url.searchParams.get("apiKey");
  if (!apiKey) return new Response("Missing apiKey", { status: 401 });
  if (gateRateLimited(apiKey)) return new Response("Too many signaling attempts", { status: 429 });
  if (!(await sessionExists(apiKey, env))) return new Response("Unauthorized", { status: 401 });

  const roomId = decodeURIComponent(match[1]);
  const id = env.SIGNALING_DO.idFromName(roomId);
  return env.SIGNALING_DO.get(id).fetch(request);
}

// Forward-only relay. DO stays dumb about SDP/ICE semantics. One room = one deviceId,
// two roles (agent + client). WebSocket Hibernation: ping/pong auto-replied by runtime,
// never wakes the DO, never billed while idle.
export class SignalingDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    // peerId identifies a specific client (deviceId:tab). Multiple clients share
    // a room (room = apiKey), so role alone can't address them.
    const peerId = url.searchParams.get("from") || null;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, peerId });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Route by peerId when addressed to a specific client, by role otherwise
  // ("agent" — exactly one per room).
  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const { to, from, type, payload } = msg;
    if (!to || !type) return;
    const target = this.ctx.getWebSockets().find((peer) => {
      if (peer === ws) return false;
      const att = peer.deserializeAttachment();
      return to === "agent" ? att?.role === "agent" : att?.peerId === to;
    });
    if (target) target.send(JSON.stringify({ type, payload, from }));
  }

  async webSocketClose() {}
}
