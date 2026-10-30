// SignalingDO relay rules that fail silently — a dropped message looks identical
// to a delivered one on the sender's side. Runs the class against a fake DO
// context; no network, no Worker.
//
// Run: node web/test/signalingDoRelay.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The DO imports `cloudflare:workers`, which only exists in the Workers runtime.
// Swap it for a stub and load the rest through a data: URL — the relay rules
// under test never touch the base class.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../durable-objects/SignalingDO.js"), "utf8")
  .replace(/^import \{ DurableObject \} from "cloudflare:workers";$/m, `
class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
const WebSocketRequestResponsePair = class {};
// Server half only needs an attachment store — the relay reads nothing else.
const WebSocketPair = class { constructor() { this[0] = {}; this[1] = { _att: null, serializeAttachment(a) { this._att = a; }, deserializeAttachment() { return this._att; } }; } };`);
const { SignalingDO } = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));

// Minimal stand-in for DurableObjectState: only the websocket surface the DO uses.
function fakeCtx() {
  const sockets = [];
  return {
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
    role,
    peerId,
    sent: [],
    closed: null,
    _att: att,
    serializeAttachment(a) { this._att = a; },
    deserializeAttachment() { return this._att; },
    send(data) { this.sent.push(JSON.parse(data)); },
    close(code, reason) { this.closed = { code, reason }; }
  };
}

class FakeDO extends SignalingDO {
  constructor(ctx) { super(ctx, {}); this.ctx = ctx; }
}

const send = (ws, obj) => ws.send(JSON.stringify(obj));

// 1. Offer reaches the agent when both roles are present.
{
  const ctx = fakeCtx();
  const do_ = new FakeDO(ctx);
  const agent = fakeWs("agent", "a1");
  const client = fakeWs("client", "c1");
  ctx.sockets.push(agent, client);
  await do_.webSocketMessage(client, JSON.stringify({ to: "agent", from: "c1", type: "offer", payload: { sdp: "X" } }));
  assert.equal(agent.sent.length, 1, "agent receives the offer");
  assert.equal(agent.sent[0].type, "offer");
  console.log("  ✓ offer reaches the single agent");
}

// 2. A stale agent socket is evicted when a new agent joins — the corpse must not
//    keep absorbing offers (find() takes the first match).
{
  const stale = fakeWs("agent", "old");
  const client = fakeWs("client", "c1");
  const ctx = fakeCtx();
  ctx.sockets.push(stale, client);
  ctx.acceptWebSocket = (s) => { s.serializeAttachment({ role: "agent", peerId: "new" }); ctx.sockets.push(s); };
  const do_ = new FakeDO(ctx);
  // Plain object, not a Request: Node's undici refuses to construct one with an
  // Upgrade header ("forbidden header name"). The 101 Response is likewise
  // rejected by undici, and it is built AFTER the eviction — ignore it.
  await do_.fetch({ url: "https://x/signaling/ws/ROOM?role=agent&from=new" }).catch(() => {});
  assert.equal(stale.closed?.code, 1000, "stale agent socket is closed");
  assert.equal(ctx.sockets.filter((s) => s !== stale).length >= 1, true, "new agent stays");
  console.log("  ✓ stale agent evicted on new agent join");
}

// 3. A client joining does NOT evict the agent.
{
  const agent = fakeWs("agent", "a1");
  agent._pongAt = Date.now(); // a live agent pings — the reaper must spare it
  const ctx = fakeCtx();
  ctx.sockets.push(agent);
  ctx.acceptWebSocket = (s) => ctx.sockets.push(s);
  const do_ = new FakeDO(ctx);
  await do_.fetch({ url: "https://x/signaling/ws/ROOM?role=client&from=c9" }).catch(() => {});
  assert.equal(agent.closed, null, "agent untouched when a client joins");
  console.log("  ✓ client join leaves the agent alone");
}

// 3. No agent in the room → drop is reported, not silent.
{
  const ctx = fakeCtx();
  const do_ = new FakeDO(ctx);
  const client = fakeWs("client", "c1");
  ctx.sockets.push(client);
  await do_.webSocketMessage(client, JSON.stringify({ to: "agent", from: "c1", type: "offer", payload: {} }));
  assert.equal(client.sent.length, 0, "nothing is delivered");
  console.log("  ✓ offer with no agent is dropped without throwing");
}

// 4. peerId routing still wins for client-addressed messages.
{
  const ctx = fakeCtx();
  const do_ = new FakeDO(ctx);
  const a = fakeWs("client", "peer-a");
  const b = fakeWs("client", "peer-b");
  ctx.sockets.push(a, b);
  await do_.webSocketMessage(a, JSON.stringify({ to: "peer-b", from: "peer-a", type: "ice", payload: { candidate: "c" } }));
  assert.equal(b.sent.length, 1, "addressed peer receives");
  assert.equal(a.sent.length, 0, "sender does not receive its own message");
  console.log("  ✓ peerId addressing unchanged");
}

// 5. Presence probe — what /api/connect asks before it refuses a login for a
//    missing tunnel. Only the agent role counts; a room full of clients is not
//    a room anyone can reach.
{
  const empty = fakeCtx();
  const noAgent = await new FakeDO(empty).fetch({ url: "https://x/presence" });
  assert.equal((await noAgent.json()).agentPresent, false, "empty room reports no agent");

  const ctx = fakeCtx();
  ctx.sockets.push(fakeWs("client", "c1"));
  const clientsOnly = await new FakeDO(ctx).fetch({ url: "https://x/presence" });
  assert.equal((await clientsOnly.json()).agentPresent, false, "clients alone do not answer for the agent");

  ctx.sockets.push(fakeWs("agent", "a1", Date.now()));
  const withAgent = await new FakeDO(ctx).fetch({ url: "https://x/presence" });
  assert.equal((await withAgent.json()).agentPresent, true, "fresh agent is visible to the probe");
  console.log("  ✓ presence probe reports the agent role only");
}

// 6. Presence freshness — a socket that stopped speaking (host asleep, TCP
//    half-open) must not vouch for the agent. The agent's "hb" beat re-stamps
//    liveness and is never forwarded to clients.
{
  const ctx = fakeCtx();
  const corpse = fakeWs("agent", "a1", Date.now() - 200000); // silent past AGENT_FRESH_MS
  const legacy = fakeWs("agent", "a2"); // no stamp at all
  ctx.sockets.push(corpse, legacy);
  const res = await new FakeDO(ctx).fetch({ url: "https://x/presence" });
  assert.equal((await res.json()).agentPresent, false, "silent agent sockets do not answer presence");

  const ctx2 = fakeCtx();
  const agent = fakeWs("agent", "a1", Date.now() - 200000);
  const client = fakeWs("client", "c1");
  ctx2.sockets.push(agent, client);
  await new FakeDO(ctx2).webSocketMessage(agent, JSON.stringify({ to: "client", from: "agent", type: "hb" }));
  assert.equal(client.sent.length, 0, "hb is not forwarded");
  assert.equal(Date.now() - agent.deserializeAttachment().aliveAt < 180000, true, "hb re-stamps aliveAt");
  const res2 = await new FakeDO(ctx2).fetch({ url: "https://x/presence" });
  assert.equal((await res2.json()).agentPresent, true, "a beat brings the agent back");
  console.log("  ✓ presence freshness + hb beat");
}

// 8. ice-batch — clients coalesce trickle candidates into one message (one DO
// wake); the relay fans it back out as plain per-candidate messages.
{
  const ctx = fakeCtx();
  const do_ = new FakeDO(ctx);
  const agent = fakeWs("agent", "a1");
  const client = fakeWs("client", "c1");
  ctx.sockets.push(agent, client);
  await new FakeDO(ctx).webSocketMessage(client, JSON.stringify({
    to: "agent", from: "c1", type: "ice-batch",
    payload: [{ candidate: "cand-a", mid: "0" }, { candidate: "cand-b", mid: "1" }]
  }));
  assert.equal(agent.sent.length, 2, "one candidate per fanned-out message");
  assert.equal(agent.sent[0].type, "ice", "fanned out as plain ice");
  assert.deepEqual(agent.sent[0].payload, { candidate: "cand-a", mid: "0" }, "payload carried verbatim");
  assert.equal(agent.sent[0].from, "c1", "sender preserved on every item");
  assert.equal(agent.sent[1].from, "c1");

  // A malformed batch (non-array payload) takes the generic forward once — the
  // host ignores an unknown type like any other unaddressable message.
  const ctx2 = fakeCtx();
  const agent2 = fakeWs("agent", "a2");
  const client2 = fakeWs("client", "c2");
  ctx2.sockets.push(agent2, client2);
  await new FakeDO(ctx2).webSocketMessage(client2, JSON.stringify({ to: "agent", from: "c2", type: "ice-batch", payload: "junk" }));
  assert.equal(agent2.sent.length, 1, "non-array payload forwards once, untouched");
  assert.equal(agent2.sent[0].type, "ice-batch", "generic relay keeps the type");
  console.log("  ✓ ice-batch fan-out");
}

// 9. No-agent refusal — a client joining a room without its agent gets 409:
//    nothing in an empty room can answer an offer, so the socket would only
//    churn (measured Oct 2026: dead-host rooms looping join→close ~25/min).
{
  const ctx = fakeCtx();
  ctx.acceptWebSocket = (s) => ctx.sockets.push(s);
  const do_ = new FakeDO(ctx);
  const res = await do_.fetch({ url: "https://x/signaling/ws/ROOM?role=client&from=c9" }).catch(() => null);
  assert.equal(res?.status, 409, "client join refused when no agent");
  assert.equal(ctx.sockets.length, 0, "no socket accepted");

  // The agent join into an empty room is the normal host startup — never refused.
  const ctx2 = fakeCtx();
  ctx2.acceptWebSocket = (s) => ctx2.sockets.push(s);
  const res2 = await new FakeDO(ctx2).fetch({ url: "https://x/signaling/ws/ROOM?role=agent&from=a1" }).catch(() => null);
  assert.notEqual(res2?.status, 409, "agent join into empty room is never refused");
  console.log("  ✓ no-agent refusal gates clients only");
}

// 10. Per-socket message budget: every WS frame is a billed wake and frames are
//     opaque before the DO, so closing the flooding socket is the only stop.
{
  const ctx = fakeCtx();
  const do_ = new FakeDO(ctx);
  const agent = fakeWs("agent", "a1");
  const client = fakeWs("client", "c1");
  ctx.sockets.push(agent, client);
  client.close = (code, reason) => { client.closed = { code, reason }; };
  const frame = JSON.stringify({ to: "agent", from: "c1", type: "ice", payload: { c: 1 } });
  for (let i = 0; i < 150; i++) await do_.webSocketMessage(client, frame);
  assert.equal(client.closed?.code, 1008, "flooding socket closed at the budget");
  assert.ok(agent.sent.length <= 120, "at most MSG_MAX frames were relayed");
  console.log("  ✓ per-socket message budget closes a flood");
}

// 11. The budget never clips legit traffic — a normal burst flows untouched.
{
  const ctx = fakeCtx();
  const do_ = new FakeDO(ctx);
  const agent = fakeWs("agent", "a1");
  const client = fakeWs("client", "c1");
  ctx.sockets.push(agent, client);
  for (let i = 0; i < 30; i++) {
    await do_.webSocketMessage(client, JSON.stringify({ to: "agent", from: "c1", type: "ice", payload: { c: i } }));
  }
  assert.equal(client.closed, null, "legit burst stays open");
  assert.equal(agent.sent.length, 30, "all legit frames relayed");
  console.log("  ✓ legit bursts unaffected");
}

console.log("\n11 passed");
