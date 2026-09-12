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
    setWebSocketAutoResponse: () => {}
  };
}

function fakeWs(role, peerId) {
  return {
    role,
    peerId,
    sent: [],
    closed: null,
    serializeAttachment: () => ({ role, peerId }),
    deserializeAttachment: () => ({ role, peerId }),
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

console.log("\n4 passed");
