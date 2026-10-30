// Presence must vouch for a live agent and no one else. The DO's own aliveAt
// (WS hb) fades out as hosts drop the 60s hb — the D1 HTTP heartbeat
// (agentSeenAt, 120s via /api/session/heartbeat) is the durable signal.
// Runs the class against a fake DO context; no network, no Worker.
//
// Run: node web/test/signalingDoPresence.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../durable-objects/SignalingDO.js"), "utf8")
  .replace(/^import \{ DurableObject \} from "cloudflare:workers";$/m, `
class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
const WebSocketRequestResponsePair = class {};
const WebSocketPair = class { constructor() { this[0] = {}; this[1] = { _att: null, serializeAttachment(a) { this._att = a; }, deserializeAttachment() { return this._att; } }; } };`);
const { SignalingDO } = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

const ROOM = "sk-0123abcd-12345678";

// Fake D1: returns the seeded agentSeenAt row and records the query.
function fakeDb(agentSeenAt) {
  return {
    queries: [],
    prepare(sql) {
      const q = { sql, _bind: null, bind(...args) { this._bind = args; return this; }, async first() { return agentSeenAt === undefined ? null : { agentSeenAt }; } };
      this.queries.push(q);
      return q;
    }
  };
}

function fakeCtx(sockets, db) {
  return {
    id: { name: ROOM },
    sockets,
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
    setWebSocketAutoResponse: () => {},
    // Runtime stamps this on every auto-answered "ping"; fake ws sets _pongAt.
    getWebSocketAutoResponseTimestamp: (ws) => (ws._pongAt ? new Date(ws._pongAt) : null)
  };
}

function fakeWs(role, peerId, aliveAt) {
  const att = { role, peerId, ...(aliveAt !== undefined ? { aliveAt } : {}) };
  return {
    role, peerId,
    _att: att,
    serializeAttachment(a) { this._att = a; },
    deserializeAttachment() { return this._att; },
    send() {},
    close() {}
  };
}

const presence = async (do_, db) => {
  const res = await do_.fetch({ url: "https://do/presence" });
  const body = await res.json();
  assert.equal(db.queries.filter((q) => q.sql.includes("agentSeenAt")).length <= 1, true, "at most one D1 presence read");
  return body.agentPresent;
};

const MIN = 60_000;

// 1. Agent socket + fresh D1 heartbeat (no WS hb — post-cleanup host) → present.
{
  const db = fakeDb(new Date(Date.now() - 2 * MIN).toISOString().slice(0, 19).replace("T", " "));
  const agent = fakeWs("agent", "a1");
  const do_ = new SignalingDO(fakeCtx([agent], db), { DB: db });
  assert.equal(await presence(do_, db), true, "fresh agentSeenAt vouches");
  console.log("  ✓ agent socket + fresh agentSeenAt → present");
}

// 2. No agent socket → not present, whatever D1 says (fast path, no D1 read).
{
  const db = fakeDb(new Date().toISOString().slice(0, 19).replace("T", " "));
  const client = fakeWs("client", "c1");
  const do_ = new SignalingDO(fakeCtx([client], db), { DB: db });
  const readsBefore = db.queries.length;
  assert.equal(await presence(do_, db), false, "no agent socket");
  assert.equal(db.queries.length, readsBefore, "socket-miss must skip the D1 read");
  console.log("  ✓ no agent socket → not present, no D1 read");
}

// 3. Corpse: agent socket lingers, both signals stale → not present.
{
  const stale = new Date(Date.now() - 10 * MIN).toISOString().slice(0, 19).replace("T", " ");
  const db = fakeDb(stale);
  const agent = fakeWs("agent", "a1", Date.now() - 10 * MIN);
  const do_ = new SignalingDO(fakeCtx([agent], db), { DB: db });
  assert.equal(await presence(do_, db), false, "stale everything must not vouch");
  console.log("  ✓ lingering corpse socket → not present");
}

// 4. Old host still WS-heartbeating (aliveAt fresh) even if its D1 beat is
//    late → present. Belt for hosts whose HTTP heartbeat is flaky.
{
  const stale = new Date(Date.now() - 10 * MIN).toISOString().slice(0, 19).replace("T", " ");
  const db = fakeDb(stale);
  const agent = fakeWs("agent", "a1", Date.now() - 30_000);
  const do_ = new SignalingDO(fakeCtx([agent], db), { DB: db });
  assert.equal(await presence(do_, db), true, "fresh aliveAt still vouches");
  console.log("  ✓ fresh aliveAt (old host) → present");
}

// 5. No session row → not present.
{
  const db = fakeDb(undefined);
  const agent = fakeWs("agent", "a1");
  const do_ = new SignalingDO(fakeCtx([agent], db), { DB: db });
  assert.equal(await presence(do_, db), false, "missing row must not vouch");
  console.log("  ✓ missing D1 row → not present");
}

// 6. JSON hb from an un-updated host still stamps aliveAt — old path intact.
{
  const db = fakeDb(undefined);
  const agent = fakeWs("agent", "a1");
  const do_ = new SignalingDO(fakeCtx([agent], db), { DB: db });
  await do_.webSocketMessage(agent, JSON.stringify({ to: "agent", from: "a1", type: "hb" }));
  assert.ok(agent._att.aliveAt, "hb restamps aliveAt for old hosts");
  console.log("  ✓ old-host JSON hb still stamps aliveAt");
}

// 7. Post-hb host: no aliveAt, stale D1, but the runtime kept answering its
//    10s pings — the free auto-response stamp vouches without a D1 read.
{
  const stale = new Date(Date.now() - 10 * MIN).toISOString().slice(0, 19).replace("T", " ");
  const db = fakeDb(stale);
  const agent = fakeWs("agent", "a1");
  agent._pongAt = Date.now() - 30_000;
  const do_ = new SignalingDO(fakeCtx([agent], db), { DB: db });
  const readsBefore = db.queries.length;
  assert.equal(await presence(do_, db), true, "fresh ping stamp vouches");
  assert.equal(db.queries.length, readsBefore, "ping-stamp path must skip the D1 read");
  console.log("  ✓ fresh auto-response stamp → present, no D1 read");
}

// 8. Reconnect storm: a role exceeding STORM_MAX_JOINS in the window is 429'd,
//    and the other role is unaffected. Node's Response rejects status 101, so
//    an admitted join surfaces as the throw, a refusal as a real 429.
{
  const joinStatus = async (do_, url) => {
    try { return (await do_.fetch({ url })).status; } catch { return 101; }
  };
  const db = fakeDb(undefined);
  // A live room — the no-agent gate only admits client joins when an agent is
  // present, and a storm against a live room is the scenario worth testing.
  const agent = fakeWs("agent", "a1");
  agent._pongAt = Date.now(); // a live agent pings — the reaper must spare it
  const do_ = new SignalingDO(fakeCtx([agent], db), { DB: db });
  for (let i = 0; i < 10; i++) {
    assert.equal(await joinStatus(do_, "https://do/ws?role=client&from=c" + i), 101, "join " + (i + 1) + " within budget");
  }
  assert.equal(await joinStatus(do_, "https://do/ws?role=client&from=storm"), 429, "join past budget is refused");
  assert.equal(await joinStatus(do_, "https://do/ws?role=agent&from=agent"), 101, "client storm must not 429 the agent role");
  console.log("  ✓ storm breaker: 429 past budget, per-role");
}

// 9. Doc semantics (DurableObjectState::getWebSocketAutoResponseTimestamp):
//    a stale stamp only means the ping path is dead — the durable D1 heartbeat
//    still vouches. Liveness layering, not either/or.
{
  const fresh = new Date(Date.now() - 2 * MIN).toISOString().slice(0, 19).replace("T", " ");
  const db = fakeDb(fresh);
  const agent = fakeWs("agent", "a1");
  agent._pongAt = Date.now() - 10 * MIN; // pings stopped, socket lingers
  const do_ = new SignalingDO(fakeCtx([agent], db), { DB: db });
  assert.equal(await presence(do_, db), true, "fresh agentSeenAt rescues a silent socket");
  console.log("  ✓ stale ping stamp + fresh D1 → present");
}

// 10. Storm window rolls: doc says hibernation resets constructor state, but
//     while awake the window must prune — a peer blocked at t0 may rejoin once
//     STORM_WINDOW_MS has passed. Refusals must not extend the window.
{
  const joinStatus = async (do_, url) => {
    try { return (await do_.fetch({ url })).status; } catch { return 101; }
  };
  const db = fakeDb(undefined);
  const agent10 = fakeWs("agent", "a1");
  agent10._pongAt = Date.now(); // live agent — spared by the reaper
  const do_ = new SignalingDO(fakeCtx([agent10], db), { DB: db });
  const realNow = Date.now;
  const t0 = realNow();
  try {
    Date.now = () => t0;
    for (let i = 0; i < 10; i++) await joinStatus(do_, "https://do/ws?role=client&from=c" + i);
    assert.equal(await joinStatus(do_, "https://do/ws?role=client&from=storm"), 429, "blocked inside the window");
    // A refused attempt at t0+10s must not push into the window.
    Date.now = () => t0 + 10_000;
    assert.equal(await joinStatus(do_, "https://do/ws?role=client&from=storm2"), 429, "refusal does not extend the window");
    // Past the window the oldest joins prune out — the role may join again.
    Date.now = () => t0 + 31_000;
    assert.equal(await joinStatus(do_, "https://do/ws?role=client&from=fresh"), 101, "window rolled — rejoin admitted");
  } finally {
    Date.now = realNow;
  }
  console.log("  ✓ storm window prunes and refusals do not extend it");
}

// 11. Corpse reaper: an agent socket stale on all three layers is closed on
//     the next client join — the room empties and the no-agent gate refuses.
{
  const stale = new Date(Date.now() - 10 * MIN).toISOString().slice(0, 19).replace("T", " ");
  const db = fakeDb(stale);
  const corpse = fakeWs("agent", "a1"); // no _pongAt, no aliveAt, stale D1
  corpse.close = (code) => { corpse.closedCode = code; };
  const do_ = new SignalingDO(fakeCtx([corpse], db), { DB: db });
  const res = await do_.fetch({ url: "https://do/ws?role=client&from=c1" }).catch(() => null);
  assert.equal(corpse.closedCode, 1000, "corpse reaped on client join");
  assert.equal(res?.status, 409, "room is empty after the reap — join refused");
}

// 12. The reaper never touches the living: a fresh ping stamp alone spares the
//     socket, and so does a fresh D1 heartbeat behind a silent socket.
{
  const staleD1 = new Date(Date.now() - 10 * MIN).toISOString().slice(0, 19).replace("T", " ");
  const db = fakeDb(staleD1);
  const live = fakeWs("agent", "a1");
  live._pongAt = Date.now() - 10_000; // pinged 10s ago
  live.close = (code) => { live.closedCode = code; };
  await new SignalingDO(fakeCtx([live], db), { DB: db }).fetch({ url: "https://do/ws?role=client&from=c1" }).catch(() => null);
  assert.equal(live.closedCode, undefined, "fresh ping stamp spares the agent");

  const freshD1 = new Date(Date.now() - 30_000).toISOString().slice(0, 19).replace("T", " ");
  const db2 = fakeDb(freshD1);
  const silent = fakeWs("agent", "a1"); // no stamp, no aliveAt — restarting host
  silent.close = (code) => { silent.closedCode = code; };
  await new SignalingDO(fakeCtx([silent], db2), { DB: db2 }).fetch({ url: "https://do/ws?role=client&from=c1" }).catch(() => null);
  assert.equal(silent.closedCode, undefined, "fresh D1 heartbeat spares a silent socket");
}

// 13. Proxy migration: with the proxy on ("all" — every room), an hb reaching
//     the DO proves a pre-proxy socket (the proxy absorbs hb) — it is closed
//     once so the host reconnects through the proxy. Flag off → silent consume.
{
  const agent = fakeWs("agent", "a1");
  agent.close = (code) => { agent.closedCode = code; };
  const do_ = new SignalingDO(fakeCtx([agent], fakeDb(undefined)), { SIGNALING_PROXY: "all" });
  await do_.webSocketMessage(agent, JSON.stringify({ to: "agent", from: "a1", type: "hb" }));
  assert.equal(agent.closedCode, 1000, "old-path socket closed for migration");

  const agent2 = fakeWs("agent", "a1");
  agent2.close = (code) => { agent2.closedCode = code; };
  const do2 = new SignalingDO(fakeCtx([agent2], fakeDb(undefined)), {});
  await do2.webSocketMessage(agent2, JSON.stringify({ to: "agent", from: "a1", type: "hb" }));
  assert.equal(agent2.closedCode, undefined, "no flag → hb consumed silently, no loop");
}

console.log("signalingDoPresence: all green");
