// Which agent endpoint a local page must address itself by. Getting this wrong
// is silent: the page asks an origin that hosts no agent API, the login falls
// through to the Worker, and a dead tunnel then blocks a machine the LAN could
// reach. Run: node --import ./test/loader-alias.mjs test/localAgentOrigin.test.mjs
import assert from "node:assert/strict";
import { agentOriginFrom, hostOriginFrom, isSameMachine, isHostEnvironment } from "../shared/utils/localOrigin.js";
import { LOCAL_AGENT_ORIGIN, LOCAL_HOST_ORIGIN, AGENT_PORT } from "../shared/constants/API.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const at = (url) => {
  const u = new URL(url);
  global.window = { location: { hostname: u.hostname, origin: u.origin, protocol: u.protocol, port: u.port } };
};

const payload = { permanentKey: "sk-abc", loopbackOrigin: LOCAL_AGENT_ORIGIN, localIp: "172.16.0.118:2208" };

test("dev-server page is pointed at the agent, not at itself", () => {
  at("http://localhost:3000/login");
  assert.equal(agentOriginFrom(payload), LOCAL_AGENT_ORIGIN);
  assert.equal(hostOriginFrom(payload), LOCAL_HOST_ORIGIN);
});

test("dev server on 127.0.0.1 is pointed at the agent", () => {
  at("http://127.0.0.1:3000/login");
  assert.equal(agentOriginFrom(payload), LOCAL_AGENT_ORIGIN);
});

// The agent serving its own page: it IS the agent, so its own origin stands.
// Pointing it at 127.0.0.1 instead would move the carrier off the origin the
// page was loaded from, for no gain.
test("agent-served page keeps its own origin", () => {
  at(`http://localhost:${AGENT_PORT}/workspace/`);
  assert.equal(agentOriginFrom(payload), null);
});

test("agent-served page on 127.0.0.1 also keeps its own origin", () => {
  at(`http://127.0.0.1:${AGENT_PORT}/workspace/`);
  assert.equal(agentOriginFrom(payload), null);
});

// A remote page must keep its own origin — the tunnel is its carrier, and
// 127.0.0.1 there is the viewer's own machine, not the agent.
test("a remote page is left alone", () => {
  at("https://dev.9remote.cc/workspace/");
  assert.equal(agentOriginFrom(payload), null);
});

test("a LAN page is left alone", () => {
  at("http://172.16.0.118:3000/workspace/");
  assert.equal(agentOriginFrom(payload), null);
});

// No agent answered (dev server on a machine not running one) — the constant is
// the only address left to try, and its failure is the login falling back to
// the Worker, which is the behavior that existed before any of this.
test("no payload falls back to the known agent origin", () => {
  at("http://localhost:3000/login");
  assert.equal(agentOriginFrom(null), LOCAL_AGENT_ORIGIN);
});

test("agent payload without a loopback answer still resolves", () => {
  at("http://localhost:3000/login");
  assert.equal(agentOriginFrom({ permanentKey: "sk-abc" }), LOCAL_AGENT_ORIGIN);
});

test("isSameMachine returns true on localhost dev server", () => {
  at("http://localhost:3000/workspace");
  assert.equal(isSameMachine(), true);
});

test("isSameMachine returns true on 127.0.0.1 agent port", () => {
  at(`http://127.0.0.1:${AGENT_PORT}/workspace`);
  assert.equal(isSameMachine(), true);
});

test("isSameMachine returns true in Tauri desktop app even on custom domain", () => {
  at("https://app.9remote.cc/workspace");
  global.window.__TAURI__ = {};
  assert.equal(isSameMachine(), true);
  delete global.window.__TAURI__;
});

test("isSameMachine returns false on remote origin", () => {
  at("https://dev.9remote.cc/workspace");
  assert.equal(isSameMachine(), false);
});

test("isSameMachine returns false on LAN IP", () => {
  at("http://192.168.1.50:2208/workspace");
  assert.equal(isSameMachine(), false);
});

test("isHostEnvironment returns true on 127.0.0.1 agent port", () => {
  at(`http://127.0.0.1:${AGENT_PORT}/workspace`);
  assert.equal(isHostEnvironment(), true);
});

test("isHostEnvironment returns false on remote origin", () => {
  at("https://dev.9remote.cc/workspace");
  assert.equal(isHostEnvironment(), false);
});

delete global.window;

test("isSameMachine returns false when window is undefined", () => {
  assert.equal(isSameMachine(), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
