// Mode switch = agent switch on the v2 server (opencode's agent IS its mode:
// build = full access, plan = read-only). Measured: the v2 runner reads only
// agent.permissions, so a v1 session ruleset PATCH would be inert.
// Run: node agent/test/opencodeModes.test.mjs
import assert from "node:assert/strict";
import { OpenCodeAdapter } from "../features/ai/adapters/opencodeAdapter.js";
import { OPENCODE_MODE_AGENTS } from "../features/ai/constants.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function fakeServer() {
  const state = { agents: [], prompted: [] };
  return {
    state,
    listCommands: async () => [],
    runCommand: async () => ({}),
    createSession: async () => ({ id: "ses_new" }),
    prompt: async (sessionId, body) => { state.prompted.push(body); },
    setSessionModel: async () => {},
    setSessionAgent: async (sessionId, agent) => { state.agents.push({ sessionId, agent }); },
    interruptSession: async () => {},
    activeSessions: async () => ({}),
    subscribeBus: () => ({ close() {} }),
  };
}

function makeAdapter(server, mode) {
  const adapter = new OpenCodeAdapter({ cwd: "/tmp", onEvent: () => {}, server });
  adapter.setOptions(mode ? { mode } : {});
  return adapter;
}

console.log("Running opencode mode→agent tests...");

await test("the mode table maps onto real agent ids", () => {
  assert.equal(OPENCODE_MODE_AGENTS.auto, "build");
  assert.equal(OPENCODE_MODE_AGENTS.plan, "plan");
});

await test("first prompt applies the mode's agent right after session create", async () => {
  const server = fakeServer();
  const adapter = makeAdapter(server, "plan");
  await tick();
  adapter.sendPrompt("hello");
  await tick();
  assert.deepEqual(server.state.agents, [{ sessionId: "ses_new", agent: "plan" }]);
  assert.ok(server.state.prompted.length, "prompt must still go out");
});

await test("switching mode on a live session switches the agent", async () => {
  const server = fakeServer();
  const adapter = makeAdapter(server, "auto");
  await tick();
  adapter.sendPrompt("hello");
  await tick();
  adapter.setOptions({ mode: "plan" });
  await tick();
  assert.equal(server.state.agents.length, 2);
  assert.equal(server.state.agents[0].agent, "build");
  assert.equal(server.state.agents[1].agent, "plan");
});

await test("an unknown mode switches nothing", async () => {
  const server = fakeServer();
  const adapter = makeAdapter(server, "auto");
  await tick();
  adapter.sendPrompt("hello");
  await tick();
  adapter.setOptions({ mode: "yolo" });
  await tick();
  assert.equal(server.state.agents.length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
