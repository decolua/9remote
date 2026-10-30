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

// Cost cap at the worker, BEFORE the DO wakes: joins and presence probes are
// requests, so a per-key rate limit stops flooding keys outright. Fail-open —
// a missing binding or an experimental-limiter error must never break signaling.
async function signalingRateLimited(env, apiKey) {
  if (!env.SIGNALING_RATE_LIMITER) return false;
  try {
    const { success } = await env.SIGNALING_RATE_LIMITER.limit({ key: apiKey });
    return !success;
  } catch {
    return false;
  }
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
    if (await signalingRateLimited(env, roomId)) return new Response("Too many signaling requests", { status: 429 });
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
  if (await signalingRateLimited(env, apiKey)) return new Response("Too many signaling requests", { status: 429 });
  if (!(await sessionExists(apiKey, env))) return new Response("Unauthorized", { status: 401 });

  // The room IS the key — without this, any valid session could join someone
  // else's room and answer offers in place of their agent.
  const roomId = decodeURIComponent(match[1]).replace(/^(sk-[a-z0-9]{8}-[a-np-z1-9]{8})-[a-np-z1-9]{8}$/, "$1");
  if (roomId !== apiKey) return new Response("Room does not match apiKey", { status: 403 });

  // Agents hop through the Worker proxy when enabled ("1" = canary slice,
  // "all" = everyone) — absorbs hb/ping, 85% of DO wakes; clients always
  // connect directly to the room's DO.
  if (role === "agent" && signalingProxyEnabled(env, apiKey)) {
    return proxyAgentUpgrade(request, env, roomId, apiKey);
  }
  const id = env.SIGNALING_DO.idFromName(roomId);
  return env.SIGNALING_DO.get(id).fetch(request);
}

// ── Signaling proxy (runs in the outer Worker, not the DO) ──────────────────
// Agent connections hop through the Worker before the DO: hosts hb every 60s
// and ping every 10s, and every frame wakes the DO (wall-time billed — hb is
// 85% of all wakes). The Worker bills by request + CPU only, so a resident
// proxy connection absorbs that chatter for ~free and forwards real signaling
// verbatim. Enable with the SIGNALING_PROXY worker var ("1" = 10% canary,
// "all" = everyone); clients connect directly to the room's DO, as before.

// Decide for one host→DO frame: null = absorb at the proxy, string = forward.
export function filterHostMessage(data) {
  if (data === "ping") return null; // keepalive — answered locally, never wakes the DO
  let msg;
  try { msg = JSON.parse(data); } catch { return null; } // garbage the DO would drop anyway
  if (msg?.type === "hb") return null; // legacy liveness beat — the 85%
  return data; // real signaling, verbatim — no re-serialization, no drift
}

// Rollout control: "all" routes every agent through the proxy; "1" a 10%
// canary slice (stable hash of the room) so a bad deploy can only touch a
// tenth of the fleet before the flag comes off.
export function signalingProxyEnabled(env, apiKey) {
  if (env.SIGNALING_PROXY === "all") return true;
  if (env.SIGNALING_PROXY !== "1") return false;
  let h = 0;
  for (const ch of String(apiKey)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 10 === 0;
}

export class SignalingProxy {
  // No keepalive timer on purpose: timers set during the upgrade request are
  // cancelled once the response returns (Workers semantics), and the DO-side
  // socket hibernates fine with zero traffic — presence falls to the D1
  // agentSeenAt layer, which is exactly what it exists for.
  constructor({ hostWs, doWs }) {
    this._hostWs = hostWs;
    this._do = doWs;
    this._closed = false;
    hostWs.addEventListener("message", (e) => {
      if (this._closed) return;
      const out = filterHostMessage(e.data);
      if (out === null) {
        if (e.data === "ping") { try { hostWs.send("pong"); } catch {} }
        return;
      }
      try { doWs.send(out); } catch { this.close(); }
    });
    doWs.addEventListener("message", (e) => {
      if (this._closed || e.data === "pong") return; // pong = our own keepalive echo
      try { hostWs.send(e.data); } catch { this.close(); }
    });
    // One wire, one fate — a half-open proxy blackholes both peers.
    hostWs.addEventListener("close", () => this.close());
    doWs.addEventListener("close", () => this.close());
    hostWs.addEventListener("error", () => this.close());
    doWs.addEventListener("error", () => this.close());
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try { this._hostWs?.close(1000, "proxy closed"); } catch {}
    try { this._do.close(1000, "proxy closed"); } catch {}
  }
}

// Wire one agent upgrade through the proxy: open the DO-side socket first,
// then accept the host here and pipe both ways. A DO-side failure refuses the
// upgrade — the host's own reconnect ladder takes it from there.
async function proxyAgentUpgrade(request, env, roomId, apiKey) {
  const doUrl = `https://do/signaling/ws/${encodeURIComponent(roomId)}?role=agent&apiKey=${encodeURIComponent(apiKey)}`;
  let doWs;
  try {
    // The upgrade header is what makes this a WebSocket subrequest — without
    // it the DO runs (the join happens) but the socket never comes back, and
    // the host retries forever against a 502.
    const doRes = await env.SIGNALING_DO.get(env.SIGNALING_DO.idFromName(roomId))
      .fetch(new Request(doUrl, { headers: { Upgrade: "websocket" } }));
    doWs = doRes.webSocket;
  } catch {}
  if (!doWs) return new Response("Signaling upstream unavailable", { status: 502 });
  // The client half of a fetched WebSocket only starts delivering events (and
  // survives past the fetch context) after accept() — without it the socket
  // dies when the runtime reaps the context (~10-15s, the Oct 30 incident).
  doWs.accept();
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  new SignalingProxy({ hostWs: server, doWs });
  return new Response(null, { status: 101, webSocket: client });
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
// Per-socket message budget: a WS frame is opaque to every layer before the
// DO, so this is the only place a flooding peer can be stopped — every frame
// is a billed wake, and dropping frames still pays the wake. 120/min sits far
// above legit (~30 frames of session setup) and turns an unbounded flood into
// ~120 wakes plus the socket's reconnect ladder.
const MSG_MAX = 120;
const MSG_WINDOW_MS = 60000;
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
    this._msgHits = new Map();
  }

  // TEMP DIAGNOSTIC — see DIAG_PREFIX. j=join rf=429 na=no-agent refusal
  // reap=corpse closed hb=heartbeat fwd=relay delivered
  // drop=wasted wake (no target/malformed) probe=/presence cl=close.
  _diagTick(kind) {
    console.log(`${DIAG_PREFIX} ${kind} room=${this.ctx.id?.name?.slice(0, 12)}`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/presence") {
      this._diagTick("probe");
      const agent = this.ctx.getWebSockets().find((p) => p.deserializeAttachment()?.role === "agent");
      if (!agent?.deserializeAttachment()) return Response.json({ agentPresent: false });
      // Free liveness first: the runtime auto-answers "ping" without waking
      // this DO and stamps the reply time (live hosts ping every 10s); the
      // legacy hb attachment is the second fast path. Covers live hosts
      // without a D1 read — the D1 HTTP heartbeat is the durable fallback.
      if (this._agentSocketFresh(agent)) return Response.json({ agentPresent: true });
      if (await this._agentSeenFreshD1()) return Response.json({ agentPresent: true });
      return Response.json({ agentPresent: false });
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
    // Corpse agents make an empty room look occupied — reap before the gate,
    // so a reaped corpse immediately becomes the 409 path below (a closing
    // socket can linger in getWebSockets through the close handshake, so the
    // gate also excludes what this request just reaped).
    const reaped = role === "client" ? await this._reapStaleAgents() : null;
    // A room without its agent can do nothing for a client — the offer would be
    // dropped by the no-target path below anyway. Refusing the upgrade turns a
    // dead host's client join churn into the client's built-in pre-open failure
    // ladder, and is free: no flow works without an agent in the room.
    if (role === "client" && !this.ctx.getWebSockets().some((p) => p.deserializeAttachment()?.role === "agent" && !reaped?.has(p))) {
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

  // Layers 1–2 of the presence verdict: the runtime's auto-response stamp (a
  // live host pings every 10s, auto-answered without waking this DO) and the
  // legacy hb attachment stamp (old hosts, 60s). A stamp older than
  // AGENT_FRESH_MS means the process is dead even if its socket lingers
  // half-open.
  _agentSocketFresh(ws) {
    const now = Date.now();
    const stamp = this.ctx.getWebSocketAutoResponseTimestamp?.(ws);
    if (stamp && now - stamp.getTime() < AGENT_FRESH_MS) return true;
    const aliveAt = ws.deserializeAttachment()?.aliveAt;
    return Boolean(aliveAt && now - aliveAt < AGENT_FRESH_MS);
  }

  // Layer 3 — the durable verdict: /api/session/heartbeat beats every 120s.
  async _agentSeenFreshD1() {
    const apiKey = this.ctx.id?.name;
    if (!apiKey || !this.env?.DB) return false;
    const row = await this.env.DB.prepare("SELECT agentSeenAt FROM sessions WHERE apiKey = ?").bind(apiKey).first();
    const seen = row?.agentSeenAt ? new Date(`${String(row.agentSeenAt).replace(" ", "T")}Z`).getTime() : NaN;
    return !Number.isNaN(seen) && Date.now() - seen < AGENT_SEEN_FRESH_MS;
  }

  // Lazy corpse reaper — runs on client-join wakes. An agent socket dead on
  // all three presence layers belongs to a host that died without a clean TCP
  // close; while it lingers the room looks occupied, so client join churn
  // never ends (measured Oct 2026: 4 such rooms, ~25 joins/min each). One
  // close empties the room and the no-agent gate takes over. A live or
  // restarting host never trips it — its stamps stay fresh for minutes.
  async _reapStaleAgents() {
    const reaped = new Set();
    const agents = this.ctx.getWebSockets().filter((p) => p.deserializeAttachment()?.role === "agent");
    if (!agents.length) return reaped;
    let d1Fresh;
    for (const agent of agents) {
      if (this._agentSocketFresh(agent)) continue;
      if (d1Fresh === undefined) {
        try { d1Fresh = await this._agentSeenFreshD1(); }
        catch { d1Fresh = true; } // a D1 hiccup must never reap a socket
      }
      if (d1Fresh) continue;
      this._diagTick("reap");
      reaped.add(agent);
      try { agent.close(1000, "reaped: stale agent corpse"); } catch {}
    }
    return reaped;
  }

  // Route by peerId when addressed to a specific client, by role otherwise
  // ("agent" — exactly one per room).
  async webSocketMessage(ws, message) {
    // Budget first, no exceptions — an exempted type is a bypass path.
    let hits = this._msgHits.get(ws);
    if (!hits) { hits = []; this._msgHits.set(ws, hits); }
    const now = Date.now();
    while (hits.length && now - hits[0] >= MSG_WINDOW_MS) hits.shift();
    if (hits.length >= MSG_MAX) {
      this._diagTick("mb");
      try { ws.close(1008, "message budget exceeded"); } catch {}
      return;
    }
    hits.push(now);
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    const { to, from, type, payload } = msg;
    // Every agent message re-stamps liveness; "ping" never reaches here (runtime auto-replies it).
    const att = ws.deserializeAttachment();
    if (att?.role === "agent") ws.serializeAttachment({ ...att, aliveAt: Date.now() });
    if (type === "hb") {
      this._diagTick("hb");
      // With the proxy enabled for this room, hb can only arrive on a
      // pre-proxy socket (the proxy absorbs it) — pass-through upgrades
      // survive deploys, so close it once and the host's reconnect lands on
      // the proxy. Gated on the same rollout flag: off must not loop.
      if (signalingProxyEnabled(this.env || {}, this.ctx.id?.name)) {
        try { ws.close(1000, "migrate: signaling proxy"); } catch {}
      }
      return; // agent liveness beat — consumed here, never forwarded
    }
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

  async webSocketClose(ws) { this._msgHits.delete(ws); this._diagTick("cl"); }
}
