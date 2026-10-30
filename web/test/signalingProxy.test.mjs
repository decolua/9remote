// TDD for the signaling proxy — the Worker-side hop that absorbs host hb/ping
// (85% of DO wakes) before they reach the Durable Object. The Worker bills by
// request + CPU, not wall time, so a resident proxy connection is ~free.
// Run: node --import ./test/loader-alias.mjs web/test/signalingProxy.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../durable-objects/SignalingDO.js"), "utf8")
  .replace(/^import \{ DurableObject \} from "cloudflare:workers";$/m, `
class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
const WebSocketRequestResponsePair = class {};`);
const mod = await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
const { SignalingProxy, filterHostMessage } = mod;

let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const run = async () => {
  for (const { name, fn } of tests) {
    try { await fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  }
};

// Fake ws: records sends, drives event listeners.
function fakeWs(name) {
  const listeners = { open: [], message: [], close: [], error: [] };
  return {
    name, sent: [], closed: null, listeners,
    addEventListener(ev, fn) { listeners[ev]?.push(fn); },
    send(data) { this.sent.push(data); },
    close(code, reason) { this.closed = { code, reason }; this._fire("close"); },
    accept() {},
    _fire(ev, arg) { for (const fn of listeners[ev] || []) fn(arg); },
    _message(data) { this._fire("message", { data }); },
  };
}

const hbFrame = JSON.stringify({ to: "client", from: "agent", type: "hb", payload: { type: "hb" } });

// ── filterHostMessage: the pure decision — absorb or forward verbatim ──────
test("hb frame from the host is absorbed (the whole point)", () => {
  assert.equal(filterHostMessage(hbFrame), null);
});

test("bare ping is absorbed (the proxy answers pong itself)", () => {
  assert.equal(filterHostMessage("ping"), null);
});

test("real signaling is forwarded VERBATIM — no re-serialization, no drift", () => {
  const frame = JSON.stringify({ to: "c1", from: "agent", type: "answer", payload: { sdp: "S" } });
  assert.equal(filterHostMessage(frame), frame);
});

test("ice, offer-shaped and approval traffic all pass", () => {
  for (const type of ["ice", "error", "ice-batch"]) {
    const frame = JSON.stringify({ to: "c1", from: "agent", type, payload: { x: 1 } });
    assert.equal(filterHostMessage(frame), frame, type);
  }
});

test("garbage that is neither ping nor JSON is absorbed (the DO dropped it anyway)", () => {
  assert.equal(filterHostMessage("not-json"), null);
});

// ── SignalingProxy: two sockets wired together ─────────────────────────────
function wired() {
  const host = fakeWs("host"), dof = fakeWs("do");
  const p = new SignalingProxy({ hostWs: host, doWs: dof, pingMs: 30000 });
  return { host, dof, p };
}

test("host → DO: signaling forwarded, hb and ping never reach the DO", () => {
  const { host, dof } = wired();
  host._message(hbFrame);
  host._message("ping");
  const frame = JSON.stringify({ to: "c1", from: "agent", type: "answer", payload: {} });
  host._message(frame);
  assert.deepEqual(dof.sent, [frame], "only the real signal crossed");
});

test("host ping gets a local pong — the keepalive contract survives the hop", () => {
  const { host } = wired();
  host._message("ping");
  assert.deepEqual(host.sent, ["pong"]);
});

test("DO → host: client traffic forwarded verbatim, DO pong absorbed", () => {
  const { host, dof } = wired();
  const frame = JSON.stringify({ to: "agent", from: "c1", type: "offer", payload: { sdp: "X" } });
  dof._message(frame);
  dof._message("pong");
  assert.deepEqual(host.sent, [frame]);
});

test("host close closes the DO side, and vice versa", () => {
  const a = wired(); a.host._fire("close");
  assert.ok(a.dof.closed, "DO side closed with the host");
  const b = wired(); b.dof._fire("close");
  assert.ok(b.host.closed, "host closed with the DO side");
});

test("errors on either side tear both down — no half-open proxy", () => {
  const a = wired(); a.host._fire("error");
  assert.ok(a.dof.closed && a.host.closed, "host error closes both");
  const b = wired(); b.dof._fire("error");
  assert.ok(b.host.closed && b.dof.closed, "DO error closes both");
});

test("canary: 'all' enables everyone, off disables, '1' a stable ~10% slice", () => {
  assert.equal(mod.signalingProxyEnabled({ SIGNALING_PROXY: "all" }, "whatever"), true);
  assert.equal(mod.signalingProxyEnabled({}, "whatever"), false);
  const once = mod.signalingProxyEnabled({ SIGNALING_PROXY: "1" }, "sk-0123abcd-12345678");
  assert.equal(mod.signalingProxyEnabled({ SIGNALING_PROXY: "1" }, "sk-0123abcd-12345678"), once, "stable per key");
  let n = 0;
  for (let i = 0; i < 200; i++) {
    if (mod.signalingProxyEnabled({ SIGNALING_PROXY: "1" }, `sk-${(i * 7919).toString(16).padStart(8, "0")}-12345678`)) n++;
  }
  assert.ok(n >= 8 && n <= 40, `~10% of 200 keys, got ${n}`);
});

// ── handleSignaling routing: the flag decides who terminates the agent ─────
// The Workers runtime provides WebSocketPair as a global; stub it for Node.
globalThis.WebSocketPair = class { constructor() { this[0] = fakeWs("clientHalf"); this[1] = fakeWs("serverHalf"); } };

const KEY = "sk-0123abcd-12345678";
const agentReq = () => ({
  url: `https://x/signaling/ws/${KEY}?role=agent&apiKey=${KEY}`,
  headers: { get: (h) => (h.toLowerCase() === "upgrade" ? "websocket" : null) },
});
const fakeEnv = ({ proxy, doFetch }) => ({
  SIGNALING_PROXY: proxy,
  DB: { prepare: () => ({ bind() { return this; }, async first() { return { apiKey: KEY }; } }) },
  SIGNALING_DO: { idFromName: () => "id1", get: () => ({ fetch: doFetch }) },
});

test("flag ON + agent → proxy terminates the upgrade, DO-side socket opened", async () => {
  // undici refuses Response(101) — the runtime allows it; stub the constructor.
  const RealResponse = globalThis.Response;
  globalThis.Response = class { constructor(body, init) { Object.assign(this, init || {}); } };
  try {
    const doWs = fakeWs("do");
    let doUrl = null, doHeaders = null, accepted = false;
    doWs.accept = () => { accepted = true; };
    const res = await mod.handleSignaling(agentReq(), fakeEnv({
      proxy: "all",
      doFetch: async (req) => { doUrl = req.url; doHeaders = req.headers; return { status: 101, webSocket: doWs }; },
    }));
    assert.equal(res.status, 101, "host side upgraded through the proxy");
    assert.ok(res.webSocket, "host half returned");
    assert.match(doUrl, /role=agent/, "DO side joined as the agent");
    assert.match(doUrl, new RegExp(KEY), "DO side joined the right room");
    // Without this header the DO runs but the socket never comes back — the
    // host then retry-loops against a 502 (live incident Oct 30 2026).
    assert.ok(doHeaders instanceof Headers && doHeaders.get("upgrade") === "websocket",
      "DO subrequest must carry the websocket upgrade header");
    // Without accept() on the fetched client half, the socket dies when the
    // runtime reaps the fetch context (~10-15s — the second Oct 30 incident).
    assert.ok(accepted, "fetched DO socket is accepted before use");
  } finally {
    globalThis.Response = RealResponse;
  }
});

test("flag OFF → the original request passes straight to the DO, untouched", async () => {
  const sentinel = { status: 999, passthrough: true };
  const res = await mod.handleSignaling(agentReq(), fakeEnv({
    proxy: undefined,
    doFetch: async () => sentinel,
  }));
  assert.equal(res, sentinel, "direct DO fetch, no proxy hop");
});

test("flag ON + client → still direct to the DO (proxy is agents-only)", async () => {
  const sentinel = { status: 999, passthrough: true };
  const req = {
    url: `https://x/signaling/ws/${KEY}?role=client&apiKey=${KEY}`,
    headers: { get: (h) => (h.toLowerCase() === "upgrade" ? "websocket" : null) },
  };
  const res = await mod.handleSignaling(req, fakeEnv({ proxy: "1", doFetch: async () => sentinel }));
  assert.equal(res, sentinel, "clients never hop");
});

test("DO side unavailable → upgrade refused 502 (host ladder retries)", async () => {
  const res = await mod.handleSignaling(agentReq(), fakeEnv({
    proxy: "all",
    doFetch: async () => { throw new Error("do down"); },
  }));
  assert.equal(res.status, 502);
});

test("rate limiter: over budget → 429 before any DO contact", async () => {
  let n = 0;
  const env = fakeEnv({ proxy: undefined, doFetch: async () => ({ status: 101, webSocket: fakeWs("do") }) });
  env.SIGNALING_RATE_LIMITER = { limit: async () => ({ success: ++n <= 1 }) };
  const first = await mod.handleSignaling(agentReq(), env);
  assert.ok(first, "within budget passes through");
  const res = await mod.handleSignaling(agentReq(), env);
  assert.equal(res.status, 429, "next hit over budget is refused");
});

test("rate limiter missing or throwing → fail open (never break signaling)", async () => {
  const sentinel = { status: 999 };
  const noBinding = await mod.handleSignaling(agentReq(), fakeEnv({ proxy: undefined, doFetch: async () => sentinel }));
  assert.equal(noBinding, sentinel, "no binding → straight through");
  const broken = fakeEnv({ proxy: undefined, doFetch: async () => sentinel });
  broken.SIGNALING_RATE_LIMITER = { limit: async () => { throw new Error("boom"); } };
  const ok = await mod.handleSignaling(agentReq(), broken);
  assert.equal(ok, sentinel, "limiter error → straight through");
});

await run();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
