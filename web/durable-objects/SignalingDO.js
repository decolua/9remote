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

  // Presence probe: is an agent on this room's relay? /api/connect asks before
  // refusing a login for a missing tunnel — RTC can serve the client with no
  // tunnel at all. Only the DO knows, and the answer is a boolean about the room,
  // not about the caller — but the route is public, so it carries the same
  // session gate as the upgrade rather than trusting whoever called it.
  const presence = url.pathname.match(/^\/signaling\/presence\/([^/]+)$/);
  if (presence) {
    const roomId = decodeURIComponent(presence[1]).replace(/^(sk-[a-z0-9]{8}-[a-np-z1-9]{8})-[a-np-z1-9]{8}$/, "$1");
    if (!(await sessionExists(roomId, env))) return new Response("Unauthorized", { status: 401 });
    return env.SIGNALING_DO.get(env.SIGNALING_DO.idFromName(roomId)).fetch(new Request(new URL("/presence", url)));
  }

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
  let apiKey = url.searchParams.get("apiKey");
  if (!apiKey) return new Response("Missing apiKey", { status: 401 });
  // v2 keys room by HEAD — strip the private tail if a full key was presented.
  // Local regex (this file is inlined into worker.js and cannot import utils).
  apiKey = apiKey.replace(/^(sk-[a-z0-9]{8}-[a-np-z1-9]{8})-[a-np-z1-9]{8}$/, "$1");
  if (gateRateLimited(apiKey)) return new Response("Too many signaling attempts", { status: 429 });
  if (!(await sessionExists(apiKey, env))) return new Response("Unauthorized", { status: 401 });

  // The room IS the key — without this, any valid session could join someone
  // else's room and answer offers in place of their agent.
  const roomId = decodeURIComponent(match[1]).replace(/^(sk-[a-z0-9]{8}-[a-np-z1-9]{8})-[a-np-z1-9]{8}$/, "$1");
  if (roomId !== apiKey) return new Response("Room does not match apiKey", { status: 403 });

  const id = env.SIGNALING_DO.idFromName(roomId);
  return env.SIGNALING_DO.get(id).fetch(request);
}

// An agent that last spoke longer ago than this is a sleep/crash corpse — presence must not vouch for it.
const AGENT_FRESH_MS = 180000;
// D1 heartbeat freshness (/api/session/heartbeat beats every 120s) — mirrors
// /api/connect's OFFLINE_GRACE_SEC.
const AGENT_SEEN_FRESH_MS = 300000;
// Reconnect-storm breaker. A broken peer can loop join→die ~2×/s (measured Oct
// 2026: 177k joins/day on one room, each wake billing ~10s of DO duration —
// the room's $12.50/mo). A legit host restart joins once; even an update cycle
// stays in single digits per window. Past this rate the upgrade is refused and
// the client's own pre-open cap (5 failures) ends the loop. Per-isolate state:
// hibernation resets it, which is fine — a storm keeps the DO awake, so the
// counter survives exactly when it matters.
const STORM_MAX_JOINS = 10;
const STORM_WINDOW_MS = 30000;
// Upper bound on candidates per ice-batch (clients coalesce at the same cap) —
// a room member cannot turn one wake into an unbounded fan-out.
const ICE_BATCH_MAX = 64;
// TEMP DIAGNOSTIC (remove after the Oct 2026 wake-type survey): one compact
// line per wake. Bucketing was tried first but hibernation wipes this.* within
// seconds of idle, so buckets never filled — per-wake lines are the only shape
// that survives, and observability's 10% head sampling preserves the ratios.
const DIAG_PREFIX = "TEMP DIAGNOSTIC sigdo";

// Forward-only relay. DO stays dumb about SDP/ICE semantics. One room = one deviceId,
// two roles (agent + client). WebSocket Hibernation: ping/pong auto-replied by runtime,
// never wakes the DO, never billed while idle.
export class SignalingDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Reconnect-storm counters, per role — see STORM_MAX_JOINS. Role keys, so a
    // looping client can never 429 the room's agent, and a looping agent only
    // locks itself out until it slows to a legit cadence.
    this._joins = {};
  }

  // TEMP DIAGNOSTIC — see DIAG_PREFIX. j=join rf=429 na=no-agent refusal
  // hb=heartbeat fwd=relay delivered drop=wasted wake (no target/malformed)
  // probe=/presence cl=close.
  _diagTick(kind) {
    console.log(`${DIAG_PREFIX} ${kind} room=${this.ctx.id?.name?.slice(0, 12)}`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/presence") {
      this._diagTick("probe");
      const now = Date.now();
      const agent = this.ctx.getWebSockets().find((p) => p.deserializeAttachment()?.role === "agent");
      const att = agent?.deserializeAttachment();
      if (!att) return Response.json({ agentPresent: false });
      // Free liveness first: the runtime auto-answers "ping" without waking this
      // DO and stamps the reply time. A live host pings every 10s, so a stamp
      // older than AGENT_FRESH_MS means the process is dead even if its socket
      // lingers half-open. Covers post-hb hosts without a D1 read.
      const lastPong = this.ctx.getWebSocketAutoResponseTimestamp?.(agent);
      if (lastPong && now - lastPong.getTime() < AGENT_FRESH_MS) return Response.json({ agentPresent: true });
      // WS hb (old hosts) is the next fast path; the D1 HTTP heartbeat is the durable one.
      if (att.aliveAt && now - att.aliveAt < AGENT_FRESH_MS) return Response.json({ agentPresent: true });
      const apiKey = this.ctx.id?.name;
      if (!apiKey || !this.env?.DB) return Response.json({ agentPresent: false });
      const row = await this.env.DB.prepare("SELECT agentSeenAt FROM sessions WHERE apiKey = ?").bind(apiKey).first();
      const seen = row?.agentSeenAt ? new Date(`${String(row.agentSeenAt).replace(" ", "T")}Z`).getTime() : NaN;
      return Response.json({ agentPresent: !Number.isNaN(seen) && now - seen < AGENT_SEEN_FRESH_MS });
    }
    const role = url.searchParams.get("role");
    // Storm breaker — see STORM_MAX_JOINS. Refused attempts are not counted, so
    // the window rolls even while a storm keeps knocking.
    const now = Date.now();
    const joins = (this._joins[role] ||= []);
    while (joins.length && now - joins[0] >= STORM_WINDOW_MS) joins.shift();
    if (joins.length >= STORM_MAX_JOINS) {
      this._diagTick("rf");
      return new Response("Reconnect storm — retry later", { status: 429 });
    }
    // A room without its agent can do nothing for a client — the offer would be
    // dropped by the no-target path below anyway. Refusing the upgrade turns a
    // dead host's client join churn into the client's built-in pre-open failure
    // ladder, and is free: no flow works without an agent in the room.
    if (role === "client" && !this.ctx.getWebSockets().some((p) => p.deserializeAttachment()?.role === "agent")) {
      this._diagTick("na");
      return new Response("No agent in room — host offline", { status: 409 });
    }
    this._diagTick("j");
    joins.push(now);
    // peerId identifies a specific client (deviceId:tab). Multiple clients share
    // a room (room = apiKey), so role alone can't address them.
    const peerId = url.searchParams.get("from") || null;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, peerId, aliveAt: Date.now() });

    // One agent per room. An agent that restarted without its socket closing
    // cleanly leaves a corpse that find() would keep picking — every offer then
    // goes to a dead socket and RTC never answers.
    if (role === "agent") {
      for (const peer of this.ctx.getWebSockets()) {
        if (peer === server) continue;
        if (peer.deserializeAttachment()?.role !== "agent") continue;
        try { peer.close(1000, "superseded by new agent"); } catch {}
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // Route by peerId when addressed to a specific client, by role otherwise
  // ("agent" — exactly one per room).
  async webSocketMessage(ws, message) {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const { to, from, type, payload } = msg;
    // Every agent message re-stamps liveness; "ping" never reaches here (runtime auto-replies it).
    const att = ws.deserializeAttachment();
    if (att?.role === "agent") ws.serializeAttachment({ ...att, aliveAt: Date.now() });
    if (type === "hb") { this._diagTick("hb"); return; } // agent liveness beat — consumed here, never forwarded
    if (!to || !type) { this._diagTick("drop"); return; }
    const target = this.ctx.getWebSockets().find((peer) => {
      if (peer === ws) return false;
      const att = peer.deserializeAttachment();
      return to === "agent" ? att?.role === "agent" : att?.peerId === to;
    });
    if (!target) { this._diagTick("drop"); return; }
    this._diagTick("fwd");
    // Coalesced trickle ICE (one wake instead of N) — fanned back out as plain
    // per-candidate messages so hosts and old clients see the wire format they
    // always had. A non-array payload falls through to the generic relay.
    if (type === "ice-batch" && Array.isArray(payload)) {
      try {
        for (const candidate of payload.slice(0, ICE_BATCH_MAX)) {
          target.send(JSON.stringify({ type: "ice", payload: candidate, from }));
        }
      } catch {} // a dead target must not take the DO down with it
      return;
    }
    // A dead target must not take the DO down with it.
    try { target.send(JSON.stringify({ type, payload, from })); } catch {}
  }

  async webSocketClose() { this._diagTick("cl"); }
}
